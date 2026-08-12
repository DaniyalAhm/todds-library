from __future__ import annotations

import asyncio
import hashlib
import logging
import os
from pathlib import Path
from uuid import UUID

logger = logging.getLogger(__name__)

from meilisearch import Client as MeiliClient
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession
from app.config import settings
from app.models.book import Book, BookFormat
from app.models.bookmark import Bookmark
from app.models.chapter import Chapter
from app.models.library import Library
from app.models.metadata_cache import MetadataCache
from app.models.progress import ReadingProgress
from app.scanner.audio_parser import parse_audio
from app.scanner.cbz_parser import parse_cbz
from app.scanner.epub_parser import parse_epub
from app.scanner.file_parser import classify_file, get_file_hash, parse_filename
from app.scanner.pdf_parser import parse_pdf
from app.services.audio_health_service import build_health_dict
from app.services.metadata_service import enrich_book_metadata
from app.services.search_service import index_book_in_meili, remove_book_from_meili


EBOOK_FORMATS = {BookFormat.epub, BookFormat.pdf, BookFormat.mobi, BookFormat.cbz, BookFormat.cbr}
AUDIOBOOK_FORMATS = {BookFormat.mp3, BookFormat.m4b, BookFormat.flac, BookFormat.ogg, BookFormat.aac, BookFormat.wma}


def is_allowed_for_library(library: Library, fmt: BookFormat) -> bool:
    if library.type.value == "ebook":
        return fmt in EBOOK_FORMATS
    if library.type.value == "audiobook":
        return fmt in AUDIOBOOK_FORMATS
    return fmt in EBOOK_FORMATS | AUDIOBOOK_FORMATS


async def scan_library(
    db: AsyncSession, meili: MeiliClient, library_id: UUID
) -> dict:
    result = await db.execute(
        select(Library).where(Library.id == library_id)
    )
    library = result.scalar_one_or_none()
    if library is None:
        return {"new": 0, "updated": 0, "removed": 0}

    base_path = Path(library.path)
    if not base_path.is_dir():
        return {"new": 0, "updated": 0, "removed": 0}

    # Walk directory and find all book files. Companion ebook/audio files are
    # considered for mixed-media merging even when the library type is ebook or
    # audiobook; standalone entries still respect the configured library type.
    found_files = {}
    ebook_groups: dict[str, list[tuple[str, dict]]] = {}
    audio_group_entries: dict[str, tuple[str, dict]] = {}
    audio_groups: dict[str, list[dict]] = {}
    for root, _dirs, files in os.walk(base_path):
        for filename in files:
            filepath = Path(root) / filename
            fmt = classify_file(filename)
            allowed_standalone = is_allowed_for_library(library, fmt)
            if not allowed_standalone and fmt not in EBOOK_FORMATS | AUDIOBOOK_FORMATS:
                continue

            if fmt in AUDIOBOOK_FORMATS:
                metadata = parse_filename(str(filepath), str(base_path))
                group_key = metadata.get("book_folder_path")
                if group_key:
                    audio_groups.setdefault(group_key, []).append(
                        {
                            "path": str(filepath),
                            "format": fmt,
                            "size": filepath.stat().st_size,
                            "metadata": metadata,
                            "allowed_standalone": allowed_standalone,
                        }
                    )
                    continue
                if not allowed_standalone:
                    continue

            if not allowed_standalone and fmt not in EBOOK_FORMATS:
                continue

            file_hash = await get_file_hash(str(filepath))
            entry = {
                "path": str(filepath),
                "format": fmt,
                "size": filepath.stat().st_size,
            }
            if fmt in EBOOK_FORMATS:
                metadata = parse_filename(str(filepath), str(base_path))
                group_key = metadata.get("book_folder_path")
                if group_key:
                    ebook_groups.setdefault(group_key, []).append((file_hash, entry))
            if allowed_standalone:
                found_files[file_hash] = entry

    for group_path, files in audio_groups.items():
        if not files:
            continue
        files.sort(key=audio_sort_key)
        if len(files) == 1:
            filepath = files[0]["path"]
            file_hash = await get_file_hash(filepath)
            entry = {
                "path": filepath,
                "format": files[0]["format"],
                "size": files[0]["size"],
                "audiobook_path": filepath,
                "audiobook_format": files[0]["format"].value,
                "audio_files": [filepath],
                "group_path": group_path,
            }
            if files[0].get("allowed_standalone", True):
                found_files[file_hash] = entry
            audio_group_entries[group_path] = (file_hash, entry)
            continue

        file_hash = await grouped_file_hash(files)
        entry = {
            "path": files[0]["path"],
            "format": files[0]["format"],
            "size": sum(file_info["size"] for file_info in files),
            "audiobook_path": files[0]["path"],
            "audiobook_format": files[0]["format"].value,
            "audio_files": [file_info["path"] for file_info in files],
            "group_path": group_path,
        }
        if any(file_info.get("allowed_standalone", True) for file_info in files):
            found_files[file_hash] = entry
        audio_group_entries[group_path] = (file_hash, entry)

    for group_path, ebook_entries in ebook_groups.items():
        audio_entry = audio_group_entries.get(group_path)
        if not audio_entry:
            continue

        ebook_hash, ebook_info = preferred_ebook_entry(ebook_entries)
        audio_hash, audio_info = audio_entry
        found_files.pop(ebook_hash, None)
        found_files.pop(audio_hash, None)

        combined_hash = combined_media_hash(ebook_hash, audio_hash)
        found_files[combined_hash] = {
            "path": ebook_info["path"],
            "format": ebook_info["format"],
            "size": ebook_info["size"] + audio_info["size"],
            "ebook_path": ebook_info["path"],
            "ebook_format": ebook_info["format"].value,
            "ebook_size": ebook_info["size"],
            "audiobook_path": audio_info.get("audiobook_path") or audio_info["path"],
            "audiobook_format": audio_info.get("audiobook_format") or audio_info["format"].value,
            "audio_files": audio_info.get("audio_files") or [audio_info["path"]],
            "group_path": group_path,
        }

    # Get existing books
    result = await db.execute(
        select(Book).where(Book.library_id == library_id)
    )
    existing_book_list = list(result.scalars().all())
    existing_books = {b.file_hash: b for b in existing_book_list if b.file_hash}
    existing_books_by_path = {b.file_path: b for b in existing_book_list}
    matched_existing_ids = set()

    new_count = 0
    updated_count = 0
    removed_count = 0
    new_ids: list[UUID] = []
    updated_ids: list[UUID] = []
    enrich_ids: list[UUID] = []

    # Process new and updated files
    for file_hash, info in found_files.items():
        if file_hash in existing_books:
            existing = existing_books[file_hash]
            matched_existing_ids.add(existing.id)
            if existing.file_size != info["size"]:
                metadata = await parse_book_file(info["path"], info["format"], str(base_path), info.get("audio_files"))
                apply_media_variant_metadata(metadata, info)
                await update_book_in_db(db, existing.id, metadata)
                await asyncio.to_thread(index_book_in_meili, meili, existing)
                enrich_ids.append(existing.id)
                updated_ids.append(existing.id)
                updated_count += 1
        elif info["path"] in existing_books_by_path:
            existing = existing_books_by_path[info["path"]]
            matched_existing_ids.add(existing.id)
            metadata = await parse_book_file(info["path"], info["format"], str(base_path), info.get("audio_files"))
            apply_media_variant_metadata(metadata, info)
            metadata["file_hash"] = file_hash
            metadata["file_size"] = info["size"]
            await update_book_in_db(db, existing.id, metadata)
            await asyncio.to_thread(index_book_in_meili, meili, existing)
            enrich_ids.append(existing.id)
            updated_ids.append(existing.id)
            updated_count += 1
        else:
            metadata = await parse_book_file(info["path"], info["format"], str(base_path), info.get("audio_files"))
            apply_media_variant_metadata(metadata, info)
            metadata["file_hash"] = file_hash
            metadata["file_size"] = info["size"]
            book = await add_book_to_db(db, library_id, metadata)
            if book:
                await asyncio.to_thread(index_book_in_meili, meili, book)
                enrich_ids.append(book.id)
                new_ids.append(book.id)
                new_count += 1

    for book_id in enrich_ids:
        result = await db.execute(
            select(Book).where(Book.id == book_id)
        )
        book = result.scalar_one_or_none()
        if book:
            had_asin = bool(book.asin)
            logger.info("enrichment: book=%s title='%s' asin=%s", book.id, book.title, book.asin)
            await enrich_book_metadata(db, book)
            if not had_asin and book.asin:
                logger.info("enrichment: book=%s got asin=%s — second pass for chapter data", book.id, book.asin)
                await enrich_book_metadata(db, book)

    # Remove books that no longer have files
    for file_hash, book in existing_books.items():
        if book.id in matched_existing_ids:
            continue
        if file_hash not in found_files:
            await remove_book_from_db(db, book.id)
            await asyncio.to_thread(remove_book_from_meili, meili, book.id)
            removed_count += 1

    return {
        "new": new_count,
        "updated": updated_count,
        "removed": removed_count,
        "new_ids": new_ids,
        "updated_ids": updated_ids,
    }


def audio_sort_key(file_info: dict) -> tuple[int, str]:
    metadata = file_info.get("metadata") or {}
    index = metadata.get("folder_chapter_index")
    return (index if index is not None else 999999, file_info["path"].lower())


def preferred_ebook_entry(entries: list[tuple[str, dict]]) -> tuple[str, dict]:
    priority = {
        BookFormat.epub: 0,
        BookFormat.pdf: 1,
        BookFormat.mobi: 2,
        BookFormat.cbz: 3,
        BookFormat.cbr: 4,
    }
    return sorted(entries, key=lambda item: (priority.get(item[1]["format"], 999), item[1]["path"].lower()))[0]


def combined_media_hash(ebook_hash: str, audio_hash: str) -> str:
    sha256 = hashlib.sha256()
    sha256.update(b"mixed-media-book")
    sha256.update(b"\0")
    sha256.update(ebook_hash.encode("ascii"))
    sha256.update(b"\0")
    sha256.update(audio_hash.encode("ascii"))
    return sha256.hexdigest()


def apply_media_variant_metadata(metadata: dict, info: dict) -> None:
    for key in (
        "ebook_path",
        "ebook_format",
        "ebook_size",
        "audiobook_path",
        "audiobook_format",
        "audio_files",
        "group_path",
    ):
        if info.get(key):
            metadata[key] = info[key]


async def grouped_file_hash(files: list[dict]) -> str:
    sha256 = hashlib.sha256()
    for file_info in files:
        path = file_info["path"]
        sha256.update(path.encode("utf-8"))
        sha256.update(b"\0")
        sha256.update(str(file_info["size"]).encode("ascii"))
        sha256.update(b"\0")
        sha256.update((await get_file_hash(path)).encode("ascii"))
        sha256.update(b"\0")
    return sha256.hexdigest()


async def parse_book_file(
    file_path: str,
    fmt: BookFormat,
    library_path: str | None = None,
    audio_files: list[str] | None = None,
) -> dict:
    metadata = parse_filename(file_path, library_path)
    file_hash = await get_file_hash(file_path)
    metadata["file_hash"] = file_hash
    metadata["file_size"] = os.path.getsize(file_path)

    try:
        if fmt in (BookFormat.epub,):
            parsed = parse_epub(file_path)
            merge_metadata(metadata, parsed)
        elif fmt in (BookFormat.pdf,):
            parsed = parse_pdf(file_path)
            merge_metadata(metadata, parsed)
        elif fmt in (BookFormat.cbz, BookFormat.cbr):
            parsed = parse_cbz(file_path)
            merge_metadata(metadata, parsed)
        elif fmt in (BookFormat.mp3, BookFormat.m4b, BookFormat.flac, BookFormat.ogg, BookFormat.aac, BookFormat.wma):
            parsed = parse_audio(file_path)
            merge_metadata(metadata, parsed)
    except Exception:
        pass

    if audio_files:
        metadata["audio_files"] = audio_files
        metadata["file_size"] = sum(os.path.getsize(path) for path in audio_files)
        metadata["duration"] = 0
        metadata["chapters"] = []
        position = 0.0
        for index, audio_file in enumerate(audio_files, start=1):
            chapter_metadata = parse_filename(audio_file, library_path)
            parsed_audio = parse_audio(audio_file)
            duration = parsed_audio.get("duration") or 0
            metadata["duration"] += duration
            metadata["chapters"].append(
                {
                    "index": index,
                    "title": chapter_metadata.get("folder_chapter_title") or Path(audio_file).stem,
                    "start_position": position,
                    "end_position": position + duration,
                }
            )
            position += duration

    if fmt in (BookFormat.mp3, BookFormat.m4b, BookFormat.flac, BookFormat.ogg, BookFormat.aac, BookFormat.wma) or audio_files:
        audio_targets = audio_files or [file_path]
        metadata["audio_health"] = await asyncio.to_thread(build_health_dict, audio_targets)

    return metadata


def merge_metadata(target: dict, source: dict) -> dict:
    for key, value in source.items():
        if value not in (None, "", [], {}):
            target[key] = value
    return target


def build_extra_metadata(metadata: dict) -> dict | None:
    extra = dict(metadata.get("metadata") or {})
    for key in (
        "audio_files",
        "audio_health",
        "book_folder_path",
        "ebook_path",
        "ebook_format",
        "ebook_size",
        "audiobook_path",
        "audiobook_format",
        "group_path",
    ):
        if metadata.get(key):
            extra[key] = metadata[key]
    return extra or None


async def add_book_to_db(
    db: AsyncSession, library_id: UUID, metadata: dict
) -> Book | None:
    file_format_str = metadata.get("file_format", "unknown")
    try:
        fmt = BookFormat(file_format_str)
    except ValueError:
        fmt = BookFormat.unknown

    cover_path = None
    if metadata.get("cover_path"):
        cover_path = str(metadata["cover_path"])
    elif metadata.get("cover_data"):
        cover_dir = Path(settings.covers_dir)
        cover_dir.mkdir(parents=True, exist_ok=True)
        cover_filename = f"{metadata.get('file_hash', 'unknown')}.jpg"
        cover_path = str(cover_dir / cover_filename)
        with open(cover_path, "wb") as f:
            f.write(metadata["cover_data"])

    book = Book(
        library_id=library_id,
        title=metadata.get("title", Path(metadata.get("file_path", "unknown")).stem),
        author=metadata.get("author"),
        series=metadata.get("series"),
        series_index=metadata.get("series_index"),
        isbn=metadata.get("isbn"),
        asin=metadata.get("asin"),
        description=metadata.get("description"),
        publisher=metadata.get("publisher"),
        published_date=metadata.get("published_date"),
        language=metadata.get("language"),
        page_count=metadata.get("page_count"),
        duration=metadata.get("duration"),
        file_path=metadata.get("file_path", ""),
        file_format=fmt,
        file_size=metadata.get("file_size", 0),
        cover_path=cover_path,
        file_hash=metadata.get("file_hash"),
        extra_metadata=build_extra_metadata(metadata),
    )
    db.add(book)
    await db.commit()
    await db.refresh(book)

    # Add chapters
    chapters = metadata.get("chapters", [])
    for i, ch in enumerate(chapters):
        chapter = Chapter(
            book_id=book.id,
            index=ch.get("index", i),
            title=ch.get("title", f"Chapter {i + 1}"),
            start_position=ch.get("start_position"),
            end_position=ch.get("end_position"),
        )
        db.add(chapter)
        book.chapters.append(chapter)
    await db.commit()
    await db.refresh(book)
    return book


async def update_book_in_db(
    db: AsyncSession, book_id: UUID, metadata: dict
) -> Book:
    result = await db.execute(
        select(Book).where(Book.id == book_id)
    )
    book = result.scalar_one_or_none()
    if book is None:
        raise ValueError(f"Book {book_id} not found")

    for key in ("title", "author", "series", "series_index", "isbn", "asin",
                 "description", "publisher", "published_date", "language",
                 "page_count", "duration", "file_size", "file_hash"):
        if key in metadata:
            setattr(book, key, metadata[key])
    if any(
        key in metadata
        for key in (
            "metadata",
            "audio_files",
            "audio_health",
            "book_folder_path",
            "ebook_path",
            "ebook_format",
            "ebook_size",
            "audiobook_path",
            "audiobook_format",
            "group_path",
        )
    ):
        book.extra_metadata = build_extra_metadata(metadata)

    if "file_format" in metadata:
        try:
            book.file_format = BookFormat(metadata["file_format"])
        except ValueError:
            book.file_format = BookFormat.unknown

    if "chapters" in metadata:
        book.chapters.clear()
        for i, ch in enumerate(metadata["chapters"]):
            book.chapters.append(Chapter(
                index=ch.get("index", i),
                title=ch.get("title", f"Chapter {i + 1}"),
                start_position=ch.get("start_position"),
                end_position=ch.get("end_position"),
            ))

    await db.commit()
    await db.refresh(book)
    return book


async def remove_book_from_db(db: AsyncSession, book_id: UUID) -> None:
    result = await db.execute(
        select(Book).where(Book.id == book_id)
    )
    book = result.scalar_one_or_none()
    if book:
        await db.execute(delete(MetadataCache).where(MetadataCache.book_id == book_id))
        await db.execute(delete(ReadingProgress).where(ReadingProgress.book_id == book_id))
        await db.execute(delete(Bookmark).where(Bookmark.book_id == book_id))
        await db.execute(delete(Chapter).where(Chapter.book_id == book_id))
        await db.delete(book)
        await db.commit()
