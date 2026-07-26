from __future__ import annotations

from uuid import UUID

from meilisearch import Client as MeiliClient
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.models.book import Book, BookFormat
from app.models.library import Library

SEARCH_INDEX_NAME = "books"


def _get_index(meili: MeiliClient):
    try:
        meili.get_index(SEARCH_INDEX_NAME)
    except Exception:
        meili.create_index(SEARCH_INDEX_NAME, {"primaryKey": "id"})
    return meili.index(SEARCH_INDEX_NAME)


def _quoted_values(values: list[str]) -> str:
    return ",".join(f'"{value}"' for value in values)


def init_meili_index(meili: MeiliClient) -> None:
    try:
        meili.get_index(SEARCH_INDEX_NAME)
    except Exception:
        meili.create_index(SEARCH_INDEX_NAME, {"primaryKey": "id"})
    index = meili.index(SEARCH_INDEX_NAME)
    index.update_searchable_attributes(["title", "author", "series", "description"])
    index.update_filterable_attributes(["file_format", "library_id"])
    index.update_sortable_attributes(["title", "author"])


def index_book_in_meili(meili: MeiliClient, book: Book) -> None:
    index = _get_index(meili)
    doc = {
        "id": str(book.id),
        "title": book.title,
        "author": book.author or "",
        "series": book.series or "",
        "description": book.description or "",
        "file_format": book.file_format.value,
        "library_id": str(book.library_id),
        "cover_path": book.cover_path or "",
        "file_path": book.file_path,
    }
    index.add_documents([doc])


def remove_book_from_meili(meili: MeiliClient, book_id: UUID) -> None:
    try:
        index = _get_index(meili)
        index.delete_document(str(book_id))
    except Exception:
        pass


async def search_books(
    meili: MeiliClient,
    query: str,
    library_ids: list[UUID],
    type_filter: str = "all",
    limit: int = 20,
    offset: int = 0,
) -> list[dict]:
    index = _get_index(meili)
    if not library_ids:
        return []
    filters = []
    filters.append(
        f"library_id IN [{_quoted_values([str(library_id) for library_id in library_ids])}]"
    )
    if type_filter in ("ebook", "audiobook"):
        ebook_formats = ["epub", "pdf", "mobi", "cbz", "cbr"]
        audio_formats = ["mp3", "m4b", "flac", "ogg", "aac", "wma"]
        if type_filter == "ebook":
            filters.append(
                f"file_format IN [{_quoted_values(ebook_formats)}]"
            )
        else:
            filters.append(
                f"file_format IN [{_quoted_values(audio_formats)}]"
            )
    search_params = {
        "limit": limit,
        "offset": offset,
        "attributesToSearchOn": ["title", "author", "series", "description"],
    }
    if filters:
        search_params["filter"] = filters
    results = index.search(query, search_params)
    return results.get("hits", [])


async def fallback_search(
    db: AsyncSession,
    query: str,
    user_id: UUID,
    type_filter: str = "all",
    limit: int = 20,
    offset: int = 0,
) -> list[Book]:
    stmt = select(Book).options(selectinload(Book.chapters))
    conditions = [
        Book.library.has(Library.user_id == user_id),
        or_(
            Book.title.ilike(f"%{query}%"),
            Book.author.ilike(f"%{query}%"),
            Book.series.ilike(f"%{query}%"),
            Book.description.ilike(f"%{query}%"),
        ),
    ]
    if type_filter == "ebook":
        ebook_formats = [BookFormat.epub, BookFormat.pdf, BookFormat.mobi, BookFormat.cbz, BookFormat.cbr]
        conditions.append(Book.file_format.in_(ebook_formats))
    elif type_filter == "audiobook":
        audio_formats = [BookFormat.mp3, BookFormat.m4b, BookFormat.flac, BookFormat.ogg, BookFormat.aac, BookFormat.wma]
        conditions.append(Book.file_format.in_(audio_formats))
    for condition in conditions:
        stmt = stmt.where(condition)
    stmt = stmt.order_by(Book.title).offset(offset).limit(limit)
    result = await db.execute(stmt)
    return list(result.scalars().all())
