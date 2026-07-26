from __future__ import annotations

import os
from uuid import UUID

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models.book import Book
from app.models.bookmark import Bookmark
from app.models.chapter import Chapter
from app.models.library import Library
from app.models.progress import ReadingProgress
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
    }
    sort_column = sort_columns.get(filters.get("sort"), Book.title)
    if filters.get("order") == "desc":
        sort_column = sort_column.desc()
    query = query.order_by(sort_column).offset(filters.get("offset", 0)).limit(filters.get("limit", 50))
    result = await db.execute(query)
    books = list(result.scalars().all())
    await attach_user_progress(db, books, user_id)
    return books, total


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
        progress.book_id: progress.progress
        for progress in result.scalars().all()
    }
    for book in books:
        book.progress = progress_by_book_id.get(book.id, 0.0)


async def get_book_cover(db: AsyncSession, book_id: UUID) -> str | None:
    book = await get_book(db, book_id)
    if book and book.cover_path and os.path.isfile(book.cover_path):
        return book.cover_path
    return None


async def update_progress(
    db: AsyncSession, user_id: UUID, book_id: UUID, position: float, progress: float, location: str | None = None
) -> ReadingProgress:
    result = await db.execute(
        select(ReadingProgress).where(
            ReadingProgress.user_id == user_id,
            ReadingProgress.book_id == book_id,
        )
    )
    rp = result.scalar_one_or_none()
    if rp is None:
        rp = ReadingProgress(
            user_id=user_id,
            book_id=book_id,
            position=position,
            progress=progress,
            location=location,
        )
        db.add(rp)
    else:
        rp.position = position
        rp.progress = progress
        rp.location = location
    await db.commit()
    await db.refresh(rp)
    return rp


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
