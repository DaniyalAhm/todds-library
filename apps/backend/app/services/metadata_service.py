from __future__ import annotations

import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import UUID

from app.config import settings

logger = logging.getLogger(__name__)
from app.metadata.audible import AudibleProvider
from app.metadata.google_books import GoogleBooksProvider
from app.metadata.isbndb import ISBNdbProvider
from app.metadata.openlibrary import OpenLibraryProvider
from app.metadata.rreading_glasses import RReadingGlassesProvider
from app.models.book import Book
from app.models.chapter import Chapter
from app.models.metadata_cache import MetadataCache
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession


def _providers():
    return [
        RReadingGlassesProvider(),
        OpenLibraryProvider(),
        GoogleBooksProvider(),
        AudibleProvider(),
        ISBNdbProvider(),
    ]


async def enrich_book_metadata(db: AsyncSession, book: Book) -> Book:
    logger.info("enrich_book_metadata: book=%s title='%s' asin=%s isbn=%s", book.id, book.title, book.asin, book.isbn)
    all_results = []
    for provider in _providers():
        cached = await get_cached_metadata(db, book.id, provider.name)
        if cached:
            has_chapters = bool(cached["raw_data"].get("chapters"))
            cached_cover_path = cached["raw_data"].get("cover_path")
            cached_cover_ready = bool(cached_cover_path and Path(cached_cover_path).is_file())
            book_cover_ready = bool(book.cover_path and Path(book.cover_path).is_file())
            if not has_chapters and book.chapters and provider.name == "audible":
                logger.info("  provider %s: stale cache (no chapters) — invalidating", provider.name)
                await _delete_cached_metadata(db, book.id, provider.name)
            elif not cached_cover_ready and not book_cover_ready:
                logger.info("  provider %s: stale cache (no cover) — invalidating", provider.name)
                await _delete_cached_metadata(db, book.id, provider.name)
            else:
                logger.info(
                    "  provider %s: using cache (chapters=%s cover=%s)",
                    provider.name,
                    has_chapters,
                    cached_cover_ready,
                )
                all_results.append(cached["raw_data"])
                continue
        try:
            data = await provider.fetch(
                isbn=book.isbn,
                asin=book.asin,
                title=book.title,
                author=book.author,
            )
            if data:
                logger.info("  provider %s: returned data (chapters=%s)", provider.name, bool(data.get("chapters")))
                await cache_metadata(db, book.id, provider.name, data)
                all_results.append(data)
            else:
                logger.info("  provider %s: returned empty", provider.name)
        except Exception as exc:
            logger.error("  provider %s: exception: %s", provider.name, exc)
            continue

    if all_results:
        logger.info("  merging %d results and applying metadata", len(all_results))
        merged = merge_metadata_results(all_results)
        try:
            await apply_metadata_to_book(db, book, merged, overwrite=False)
        except Exception as exc:
            logger.error("  apply_metadata_to_book failed: %s", exc)
    else:
        logger.warning("  all providers returned empty — no metadata to apply")

    return book


async def lookup_metadata(
    db: AsyncSession,
    book_id: UUID | None = None,
    isbn: str | None = None,
    asin: str | None = None,
    title: str | None = None,
    author: str | None = None,
    force_refresh: bool = False,
) -> list[dict]:
    if book_id is not None and not force_refresh:
        cached_results = await get_all_cached_metadata(db, book_id)
        if cached_results:
            return cached_results

    results = []
    for provider in _providers():
        try:
            data = await provider.fetch(isbn=isbn, asin=asin, title=title, author=author)
            if data:
                if book_id is not None:
                    await cache_metadata(db, book_id, provider.name, data)
                result = _cacheable_metadata(data, book_id=book_id, source=provider.name)
                result["source"] = provider.name
                result["has_cover"] = bool(result.get("cover_path"))
                results.append(result)
        except Exception:
            continue
    return results


async def apply_metadata_to_book(
    db: AsyncSession, book: Book, metadata: dict, overwrite: bool = True
) -> Book:
    cover_data = metadata.get("cover_data")
    if cover_data and (overwrite or not book.cover_path):
        cover_dir = Path(settings.covers_dir)
        cover_dir.mkdir(parents=True, exist_ok=True)
        cover_filename = f"{book.file_hash or book.id}.jpg"
        cover_path = cover_dir / cover_filename
        with open(cover_path, "wb") as cover_file:
            cover_file.write(cover_data)
        book.cover_path = str(cover_path)

    for key, value in metadata.items():
        if key in {"cover_data", "source", "chapters"} or value in (None, "", [], {}):
            continue
        if not hasattr(book, key):
            continue
        if overwrite or getattr(book, key, None) in (None, ""):
            try:
                setattr(book, key, _coerce_book_metadata_value(key, value))
            except (TypeError, ValueError):
                logger.warning("  skipping invalid metadata field %s=%r", key, value)

    audible_chapters = metadata.get("chapters")
    if audible_chapters and book.chapters:
        existing = sorted(book.chapters, key=lambda c: c.start_position or 0)
        logger.info("  matching %d audible chapters to %d db chapters", len(audible_chapters), len(existing))
        for ac in audible_chapters:
            audible_start = ac.get("start_offset_ms", 0) / 1000.0
            audible_end = ac.get("end_offset_ms", 0) / 1000.0
            best = min(
                existing,
                key=lambda ec: abs((ec.start_position or 0) - audible_start),
            )
            if ac.get("title") and ac["title"] != best.title:
                logger.info("    chapter %s: '%s' -> '%s' (start %.1f)", best.index, best.title, ac["title"], audible_start)
                best.title = ac["title"]
            if audible_end > 0:
                best.end_position = audible_end
    elif audible_chapters:
        logger.warning("  audible chapters found (%d) but book has no chapters in db", len(audible_chapters))
    elif book.chapters:
        logger.warning("  book has %d chapters but no audible chapter data to match", len(book.chapters))

    await db.commit()
    await db.refresh(book)
    return book


def _coerce_book_metadata_value(key: str, value: Any) -> Any:
    if key in {"series_index", "duration"}:
        return float(value)
    if key == "page_count":
        return int(value)
    if key in {
        "title",
        "author",
        "series",
        "isbn",
        "asin",
        "description",
        "publisher",
        "published_date",
        "language",
    }:
        return str(value)
    return value


async def fetch_metadata_openlibrary(
    isbn: str | None = None, title: str | None = None, author: str | None = None
) -> dict:
    provider = OpenLibraryProvider()
    return await provider.fetch(isbn=isbn, title=title, author=author)


async def fetch_metadata_google_books(
    isbn: str | None = None, title: str | None = None, author: str | None = None
) -> dict:
    provider = GoogleBooksProvider()
    return await provider.fetch(isbn=isbn, title=title, author=author)


async def fetch_metadata_audible(
    asin: str | None = None, title: str | None = None, author: str | None = None
) -> dict:
    provider = AudibleProvider()
    return await provider.fetch(asin=asin, title=title, author=author)


async def fetch_metadata_isbndb(isbn: str | None = None) -> dict:
    provider = ISBNdbProvider()
    return await provider.fetch(isbn=isbn)


def merge_metadata_results(results: list[dict]) -> dict:
    merged = {}
    for result in results:
        for key, value in result.items():
            if value is not None and key not in merged:
                merged[key] = value
    return merged


async def cache_metadata(
    db: AsyncSession, book_id, source: str, data: dict
) -> None:
    cacheable_data = _cacheable_metadata(data, book_id=book_id, source=source)
    result = await db.execute(
        select(MetadataCache).where(
            MetadataCache.book_id == book_id,
            MetadataCache.source == source,
        )
    )
    cached = result.scalar_one_or_none()
    if cached:
        cached.raw_data = cacheable_data
        cached.last_fetched = datetime.now(timezone.utc)
    else:
        cached = MetadataCache(
            book_id=book_id,
            source=source,
            raw_data=cacheable_data,
        )
        db.add(cached)
    await db.commit()


def _cacheable_metadata(data: dict, book_id: Any | None = None, source: str | None = None) -> dict:
    cacheable = {key: value for key, value in data.items() if key != "cover_data"}
    cover_data = data.get("cover_data")
    if cover_data:
        cover_path = _persist_cached_cover(book_id, source, cover_data)
        if cover_path:
            cacheable["cover_path"] = cover_path
    return cacheable


def _persist_cached_cover(book_id: Any, source: str | None, cover_data: bytes) -> str | None:
    if not cover_data:
        return None
    cover_dir = Path(settings.covers_dir)
    cover_dir.mkdir(parents=True, exist_ok=True)
    cover_name = f"{book_id}-{source or 'metadata'}.jpg"
    cover_path = cover_dir / cover_name
    try:
        with open(cover_path, "wb") as cover_file:
            cover_file.write(cover_data)
    except OSError as exc:
        logger.warning("  failed to persist cached cover %s: %s", cover_path, exc)
        return None
    return str(cover_path)


async def _delete_cached_metadata(db: AsyncSession, book_id, source: str) -> None:
    result = await db.execute(
        select(MetadataCache).where(
            MetadataCache.book_id == book_id,
            MetadataCache.source == source,
        )
    )
    cached = result.scalar_one_or_none()
    if cached:
        await db.delete(cached)
        await db.commit()


async def get_cached_metadata(
    db: AsyncSession, book_id, source: str
) -> dict | None:
    result = await db.execute(
        select(MetadataCache).where(
            MetadataCache.book_id == book_id,
            MetadataCache.source == source,
        )
    )
    cached = result.scalar_one_or_none()
    if cached:
        raw_data = dict(cached.raw_data)
        return {"raw_data": raw_data, "last_fetched": cached.last_fetched}
    return None


async def get_all_cached_metadata(db: AsyncSession, book_id) -> list[dict]:
    result = await db.execute(
        select(MetadataCache)
        .where(MetadataCache.book_id == book_id)
        .order_by(MetadataCache.last_fetched.desc())
    )
    cached_rows = result.scalars().all()
    results = []
    for row in cached_rows:
        data = dict(row.raw_data)
        data["source"] = row.source
        data["cached"] = True
        data["last_fetched"] = row.last_fetched.isoformat() if row.last_fetched else None
        data["has_cover"] = bool(data.get("cover_path"))
        results.append(data)
    return results
