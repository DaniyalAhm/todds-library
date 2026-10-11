from __future__ import annotations

import asyncio
import os
import shutil
import uuid
from pathlib import Path
from uuid import UUID

from sqlalchemy import and_, case, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.book import Book
from app.models.bookmark import Bookmark
from app.models.chapter import Chapter
from app.models.generated_audio import GeneratedAudio
from app.models.generation_log import GenerationLog
from app.models.library import Library
from app.models.metadata_cache import MetadataCache
from app.models.progress import ReadingProgress
from app.models.subtitle import SubtitleMetadata
from app.schemas.bookmark import BookmarkCreate


def _user_library_condition(user_id: UUID):
    return Book.library.has(Library.user_id == user_id)


async def get_books(
    db: AsyncSession, filters: dict, user_id: UUID
) -> tuple[list[Book], int]:
    query = select(Book).options(selectinload(Book.chapters))

    conditions = [_user_library_condition(user_id)]
    if filters.get("library_id"):
        conditions.append(Book.library_id == filters["library_id"])
    if filters.get("search"):
        like = f"%{filters['search']}%"
        conditions.append(
            or_(
                Book.title.ilike(like),
                Book.author.ilike(like),
                Book.series.ilike(like),
                Book.description.ilike(like),
            )
        )
    if filters.get("author"):
        conditions.append(Book.author.ilike(f"%{filters['author']}%"))
    if filters.get("series"):
        conditions.append(Book.series.ilike(f"%{filters['series']}%"))
    if filters.get("format"):
        from app.models.book import BookFormat
        try:
            bf = BookFormat(filters["format"])
            conditions.append(Book.file_format == bf)
        except ValueError:
            pass

    if filters.get("in_progress"):
        conditions.append(Book.reading_progress.any(and_(
            ReadingProgress.user_id == user_id,
            ReadingProgress.progress > 0,
            ReadingProgress.progress < 1,
            ReadingProgress.completed.is_(False),
        )))

    query = query.where(and_(*conditions))

    count_query = select(func.count(Book.id))
    count_query = count_query.where(and_(*conditions))

    total_result = await db.execute(count_query)
    total = total_result.scalar_one()

    sort_columns = {
        "title": Book.title,
        "author": Book.author,
        "created_at": Book.created_at,
        "updated_at": Book.updated_at,
        "series": Book.series,
        "progress_updated_at": (
            select(func.coalesce(ReadingProgress.position_updated_at, ReadingProgress.last_updated))
            .where(ReadingProgress.book_id == Book.id, ReadingProgress.user_id == user_id)
            .scalar_subquery()
        ),
    }
    sort_column = sort_columns.get(filters.get("sort"), Book.title)
    if filters.get("order") == "desc":
        sort_column = sort_column.desc()
    query = query.order_by(sort_column, Book.id).offset(filters.get("offset", 0)).limit(filters.get("limit", 50))
    result = await db.execute(query)
    books = list(result.scalars().all())
    await attach_user_progress(db, books, user_id)
    return books, total


async def get_book_stats(db: AsyncSession, user_id: UUID) -> dict[str, int]:
    completed = or_(ReadingProgress.completed.is_(True), ReadingProgress.progress >= 1)
    in_progress = and_(ReadingProgress.completed.is_(False), ReadingProgress.progress > 0, ReadingProgress.progress < 1)
    result = await db.execute(
        select(
            func.count(Book.id).label("total"),
            func.coalesce(func.sum(case((completed, 1), else_=0)), 0).label("completed"),
            func.coalesce(func.sum(case((in_progress, 1), else_=0)), 0).label("in_progress"),
        )
        .outerjoin(ReadingProgress, and_(ReadingProgress.book_id == Book.id, ReadingProgress.user_id == user_id))
        .where(_user_library_condition(user_id))
    )
    counts = dict(result.one()._mapping)
    counts["not_started"] = counts["total"] - counts["completed"] - counts["in_progress"]
    return counts


async def get_book(db: AsyncSession, book_id: UUID) -> Book | None:
    result = await db.execute(
        select(Book)
        .options(selectinload(Book.chapters))
        .where(Book.id == book_id)
    )
    return result.scalar_one_or_none()


async def get_book_for_user(db: AsyncSession, book_id: UUID, user_id: UUID) -> Book | None:
    result = await db.execute(
        select(Book)
        .options(selectinload(Book.chapters))
        .where(Book.id == book_id, _user_library_condition(user_id))
    )
    book = result.scalar_one_or_none()
    if book is not None:
        await attach_user_progress(db, [book], user_id)
    return book


async def attach_user_progress(db: AsyncSession, books: list[Book], user_id: UUID) -> None:
    book_ids = [book.id for book in books]
    if not book_ids:
        return

    result = await db.execute(
        select(ReadingProgress).where(
            ReadingProgress.user_id == user_id,
            ReadingProgress.book_id.in_(book_ids),
        )
    )
    progress_by_book_id = {
        progress.book_id: 1.0 if progress.completed else progress.progress
        for progress in result.scalars().all()
    }
    for book in books:
        book.progress = progress_by_book_id.get(book.id, 0.0)


async def get_book_cover(db: AsyncSession, book_id: UUID) -> str | None:
    book = await get_book(db, book_id)
    if book and book.cover_path and os.path.isfile(book.cover_path):
        return book.cover_path
    return None


def database_timestamp(db: AsyncSession):
    return func.clock_timestamp() if db.get_bind().dialect.name == 'postgresql' else func.current_timestamp()


async def update_progress(
    db: AsyncSession, user_id: UUID, book_id: UUID, position: float, progress: float,
    location: str | None = None, captured_at: int | None = None,
) -> ReadingProgress:
    """Atomically save a user's newest snapshot, including intentional backward seeks."""
    if db.get_bind().dialect.name == 'postgresql':
        from sqlalchemy.dialects.postgresql import insert
    else:
        from sqlalchemy.dialects.sqlite import insert
    values = dict(
        id=uuid.uuid4(), user_id=user_id, book_id=book_id,
        position=position, progress=progress, location=location,
        captured_at=captured_at,
        position_updated_at=database_timestamp(db), last_updated=database_timestamp(db),
    )
    statement = insert(ReadingProgress).values(**values)
    changed = {key: getattr(statement.excluded, key) for key in (
        'position', 'progress', 'location', 'captured_at', 'position_updated_at', 'last_updated',
    )}
    statement = statement.on_conflict_do_update(
        index_elements=['user_id', 'book_id'], set_=changed,
        where=or_(ReadingProgress.captured_at.is_(None), ReadingProgress.captured_at < captured_at) if captured_at is not None else ReadingProgress.captured_at.is_(None),
    )
    await db.execute(statement)
    await db.commit()
    result = await db.execute(select(ReadingProgress).where(
        ReadingProgress.user_id == user_id, ReadingProgress.book_id == book_id,
    ).execution_options(populate_existing=True))
    return result.scalar_one()


async def get_progress(
    db: AsyncSession, user_id: UUID, book_id: UUID
) -> ReadingProgress | None:
    result = await db.execute(
        select(ReadingProgress).where(
            ReadingProgress.user_id == user_id,
            ReadingProgress.book_id == book_id,
        )
    )
    return result.scalar_one_or_none()


async def create_bookmark(
    db: AsyncSession, user_id: UUID, book_id: UUID, data: BookmarkCreate
) -> Bookmark:
    bookmark = Bookmark(
        user_id=user_id,
        book_id=book_id,
        position=data.position,
        location=data.location,
        note=data.note,
    )
    db.add(bookmark)
    await db.commit()
    await db.refresh(bookmark)
    return bookmark


async def get_bookmarks(
    db: AsyncSession, user_id: UUID, book_id: UUID
) -> list[Bookmark]:
    result = await db.execute(
        select(Bookmark)
        .where(Bookmark.user_id == user_id, Bookmark.book_id == book_id)
        .order_by(Bookmark.position)
    )
    return list(result.scalars().all())


async def delete_bookmark(db: AsyncSession, bookmark_id: UUID) -> None:
    result = await db.execute(
        select(Bookmark).where(Bookmark.id == bookmark_id)
    )
    bookmark = result.scalar_one_or_none()
    if bookmark:
        await db.delete(bookmark)
        await db.commit()


def _resolve_safe(path_str: str | None) -> Path | None:
    if not path_str or not isinstance(path_str, str):
        return None
    try:
        return Path(path_str).expanduser()
    except Exception:
        return None


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child_resolved = child.resolve()
        parent_resolved = parent.resolve()
    except Exception:
        return False
    try:
        child_resolved.relative_to(parent_resolved)
        return child_resolved != parent_resolved
    except ValueError:
        return False


async def _collect_book_disk_targets(
    db: AsyncSession, book: Book
) -> tuple[list[Path], list[Path], Path | None]:
    """Return (source_files, derived_files, book_folder) for a book.

    source_files live under the library root; derived_files (covers,
    subtitles, generated audio) live under data dirs.
    """
    metadata = book.extra_metadata or {}
    source_candidates: list[str] = []
    if book.file_path:
        source_candidates.append(book.file_path)
    for key in ("ebook_path", "audiobook_path"):
        value = metadata.get(key)
        if isinstance(value, str) and value:
            source_candidates.append(value)
    audio_files = metadata.get("audio_files")
    if isinstance(audio_files, list):
        for entry in audio_files:
            if isinstance(entry, str) and entry:
                source_candidates.append(entry)

    source_files: list[Path] = []
    seen: set[str] = set()
    for raw in source_candidates:
        resolved = _resolve_safe(raw)
        if resolved is None:
            continue
        key = str(resolved)
        if key not in seen:
            seen.add(key)
            source_files.append(resolved)

    derived_files: list[Path] = []
    if book.cover_path:
        cover = _resolve_safe(book.cover_path)
        if cover is not None:
            derived_files.append(cover)
    subtitle_rows = await db.execute(
        select(SubtitleMetadata).where(SubtitleMetadata.book_id == book.id)
    )
    for row in subtitle_rows.scalars().all():
        for attr in ("json_path", "srt_path", "vtt_path"):
            value = getattr(row, attr, None)
            resolved = _resolve_safe(value)
            if resolved is not None:
                derived_files.append(resolved)
    audio_rows = await db.execute(
        select(GeneratedAudio).where(GeneratedAudio.book_id == book.id)
    )
    for row in audio_rows.scalars().all():
        resolved = _resolve_safe(getattr(row, "file_path", None))
        if resolved is not None:
            derived_files.append(resolved)

    folder: Path | None = None
    for key in ("book_folder_path", "group_path"):
        value = metadata.get(key)
        resolved = _resolve_safe(value) if isinstance(value, str) else None
        if resolved is not None:
            folder = resolved
            break

    return source_files, derived_files, folder


def _delete_file_if_allowed(path: Path, allowed_roots: list[Path]) -> str | None:
    """Delete a single file if inside an allowed root. Returns error or None."""
    try:
        resolved = path.resolve()
    except Exception:
        return None  # missing/unresolvable -> treat as already gone
    if not any(
        resolved == root.resolve() or _is_within(resolved, root)
        if root.exists()
        else False
        or (not root.exists() and str(resolved).startswith(str(root) + os.sep))
        for root in allowed_roots
    ):
        return f"skipped (outside allowed roots): {path}"
    try:
        if resolved.is_file() or resolved.is_symlink():
            resolved.unlink(missing_ok=True)
    except FileNotFoundError:
        return None
    except Exception as exc:
        return f"failed to delete {resolved}: {exc}"
    return None


def _delete_book_folder(
    folder: Path, library_root: Path, source_files: list[Path]
) -> tuple[bool, list[str]]:
    """Delete the whole book folder if safe. Returns (deleted, errors)."""
    errors: list[str] = []
    try:
        folder_resolved = folder.resolve()
        library_resolved = library_root.resolve()
    except Exception:
        return False, errors
    # Never delete the library root itself or anything outside it.
    if folder_resolved == library_resolved or not _is_within(
        folder_resolved, library_resolved
    ):
        return False, errors
    try:
        if not folder_resolved.is_dir():
            return False, errors
        # Safety: only rmtree when at least one of this book's source files
        # lives inside the folder (prevents wiping an unrelated dir).
        if source_files and not any(
            _is_within(f.resolve(), folder_resolved)
            if f.exists()
            else str(f.resolve()).startswith(str(folder_resolved) + os.sep)
            for f in source_files
        ):
            return False, [f"skipped folder (no book files inside): {folder_resolved}"]
        shutil.rmtree(folder_resolved, ignore_errors=False)
        return True, errors
    except FileNotFoundError:
        return True, errors
    except Exception as exc:
        errors.append(f"failed to delete folder {folder_resolved}: {exc}")
        return False, errors


def _prune_empty_parents(start: Path, stop: Path) -> None:
    try:
        current = start.resolve()
        stop_resolved = stop.resolve()
    except Exception:
        return
    while current != stop_resolved and _is_within(current, stop_resolved):
        try:
            current.rmdir()  # only succeeds when empty
        except Exception:
            break
        current = current.parent


async def _delete_book_files_from_disk(
    db: AsyncSession, book: Book
) -> dict[str, list[str]]:
    """Delete the whole book folder + derived files. Best-effort; never raises."""
    deleted: list[str] = []
    errors: list[str] = []
    try:
        library = await db.get(Library, book.library_id)
    except Exception:
        library = None
    if library is None or not library.path:
        return {"deleted": deleted, "errors": ["library path unknown; files kept"]}
    library_root = _resolve_safe(library.path)
    if library_root is None:
        return {"deleted": deleted, "errors": ["library path invalid; files kept"]}

    source_files, derived_files, folder = await _collect_book_disk_targets(db, book)

    from app.config import settings as app_settings

    data_roots = [
        _resolve_safe(app_settings.covers_dir),
        _resolve_safe(app_settings.generated_audio_dir)
        if app_settings.generated_audio_dir
        else None,
        _resolve_safe("/data"),
    ]
    data_roots = [root for root in data_roots if root is not None]

    # 1. Whole book folder (source files).
    folder_target = folder
    if folder_target is None and source_files:
        try:
            folder_target = source_files[0].parent
        except Exception:
            folder_target = None

    folder_deleted = False
    if folder_target is not None:
        # If another book in the same library shares this folder, do NOT
        # rmtree — fall back to deleting only this book's files.
        shared = False
        try:
            folder_prefix = str(folder_target.resolve()) + os.sep
            other_books = await db.execute(
                select(Book.file_path).where(
                    Book.library_id == book.library_id, Book.id != book.id
                )
            )
            for (other_path,) in other_books.all():
                if other_path and str(other_path).startswith(folder_prefix):
                    shared = True
                    break
        except Exception:
            shared = False
        if shared:
            errors.append(
                f"folder shared with another book; deleting files only: {folder_target}"
            )
        else:
            folder_deleted, folder_errors = await asyncio.to_thread(
                _delete_book_folder, folder_target, library_root, source_files
            )
            errors.extend(folder_errors)
            if folder_deleted:
                deleted.append(str(folder_target))
                await asyncio.to_thread(
                    _prune_empty_parents, folder_target.parent, library_root
                )

    # 2. Any source files not covered by the folder delete.
    if not folder_deleted:
        for path in source_files:
            err = await asyncio.to_thread(
                _delete_file_if_allowed, path, [library_root]
            )
            if err is None:
                deleted.append(str(path))
            elif err.startswith("skipped"):
                errors.append(err)
            else:
                errors.append(err)

    # 3. Derived files (covers, subtitles, generated audio).
    for path in derived_files:
        err = await asyncio.to_thread(
            _delete_file_if_allowed, path, data_roots + [library_root]
        )
        if err is None:
            deleted.append(str(path))
        else:
            errors.append(err)

    # Deduplicate while preserving order.
    deleted = list(dict.fromkeys(deleted))
    errors = list(dict.fromkeys(errors))
    return {"deleted": deleted, "errors": errors}


async def delete_book(
    db: AsyncSession, book: Book, delete_files: bool = False
) -> dict[str, list[str]]:
    """Delete a book and all rows that reference it.

    When ``delete_files`` is True, the whole book folder is removed from
    the library directory as well as derived files (covers, subtitles,
    generated audio). Files outside the library/data roots are never
    touched. Filesystem work is best-effort: errors are returned, not
    raised, so the app rows are always removed.
    """
    result: dict[str, list[str]] = {"deleted": [], "errors": []}
    if delete_files:
        try:
            result = await _delete_book_files_from_disk(db, book)
        except Exception as exc:
            result = {"deleted": [], "errors": [f"file deletion failed: {exc}"]}

    chapter_ids_subq = select(Chapter.id).where(Chapter.book_id == book.id)

    await db.execute(
        delete(GenerationLog).where(
            or_(
                GenerationLog.book_id == book.id,
                GenerationLog.chapter_id.in_(chapter_ids_subq),
            )
        )
    )
    await db.execute(delete(SubtitleMetadata).where(SubtitleMetadata.book_id == book.id))
    await db.execute(delete(GeneratedAudio).where(GeneratedAudio.book_id == book.id))
    await db.execute(delete(MetadataCache).where(MetadataCache.book_id == book.id))
    await db.execute(delete(Bookmark).where(Bookmark.book_id == book.id))
    await db.execute(delete(ReadingProgress).where(ReadingProgress.book_id == book.id))
    await db.execute(delete(Chapter).where(Chapter.book_id == book.id))

    await db.delete(book)
    await db.commit()
    return result


async def get_book_ratings(db: AsyncSession, book: Book) -> dict:
    """Share ratings across users' copies of a work, counting each user once."""
    matches = [Book.id == book.id]
    for field in ('isbn', 'asin', 'file_hash'):
        value = getattr(book, field)
        if value and value.strip():
            matches.append(getattr(Book, field) == value)
    if book.title.strip() and book.author and book.author.strip():
        matches.append(and_(
            func.lower(func.trim(Book.title)) == book.title.strip().lower(),
            func.lower(func.trim(Book.author)) == book.author.strip().lower(),
        ))
    latest = (
        select(
            ReadingProgress.rating.label('rating'),
            func.row_number().over(
                partition_by=ReadingProgress.user_id,
                order_by=(ReadingProgress.review_updated_at.desc(), ReadingProgress.last_updated.desc(), ReadingProgress.id.desc()),
            ).label('rank'),
        )
        .join(Book, ReadingProgress.book_id == Book.id)
        .where(or_(*matches), ReadingProgress.rating.between(1, 5))
        .subquery()
    )
    rows = (await db.execute(
        select(latest.c.rating, func.count()).where(latest.c.rank == 1).group_by(latest.c.rating)
    )).all()
    distribution = {star: 0 for star in range(1, 6)}
    for rating, count in rows:
        distribution[rating] = count
    count = sum(distribution.values())
    return {
        'average_rating': sum(star * total for star, total in distribution.items()) / count if count else None,
        'rating_count': count,
        'distribution': distribution,
    }
