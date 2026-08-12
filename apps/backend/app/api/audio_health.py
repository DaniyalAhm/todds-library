from __future__ import annotations

import asyncio
import os
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, require_admin
from app.models.book import Book
from app.models.user import User
from app.services.audio_health_service import (
    check_book,
    resolve_repair_path,
    worst_status,
)
from app.services.audiobook_service import get_audio_files, rebuild_hls_playlist
from app.services.book_service import get_book_for_user
from app.services.library_service import get_library

router = APIRouter()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _health_for(book: Book) -> dict | None:
    return (book.extra_metadata or {}).get("audio_health")


@router.get("/books/{book_id}/audio-health")
async def get_book_audio_health(
    book_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    health = _health_for(book)
    if health is None and book.has_audiobook:
        health = await asyncio.to_thread(check_book, book)

    return {
        "book_id": str(book.id),
        "title": book.title,
        "has_audiobook": book.has_audiobook,
        "health": health,
    }


@router.get("/audio-health/books")
async def list_audio_health_books(
    status_filter: str | None = Query(None, alias="status"),
    library_id: UUID | None = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    query = select(Book).order_by(Book.title)
    if library_id is not None:
        query = query.where(Book.library_id == library_id)
    result = await db.execute(query)
    books = [book for book in result.scalars().all() if book.has_audiobook]

    filtered = []
    for book in books:
        health = _health_for(book)
        if status_filter is None or (health or {}).get("status") == status_filter:
            filtered.append(book)

    total = len(filtered)
    page = filtered[offset : offset + limit]
    return {
        "items": [
            {
                "book_id": str(book.id),
                "title": book.title,
                "author": book.author,
                "library_id": str(book.library_id),
                "audiobook_format": book.audiobook_format,
                "audio_track_count": book.audio_track_count,
                "health": _health_for(book),
            }
            for book in page
        ],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@router.post("/libraries/{library_id}/audio-health/scan")
async def scan_library_audio_health(
    library_id: UUID,
    full_decode: bool = Query(False),
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    library = await get_library(db, library_id, current_user)
    if library is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")

    result = await db.execute(
        select(Book).where(Book.library_id == library_id)
    )
    books = [book for book in result.scalars().all() if book.has_audiobook]

    statuses = []
    audited = 0
    for book in books:
        health = await asyncio.to_thread(check_book, book, full_decode=full_decode)
        metadata = dict(book.extra_metadata or {})
        metadata["audio_health"] = health
        book.extra_metadata = metadata
        statuses.append(health.get("status", "unchecked"))
        audited += 1
    await db.commit()

    counts = {label: statuses.count(label) for label in ("ok", "degraded", "corrupt", "unreadable", "unchecked")}
    return {
        "library_id": str(library_id),
        "full_decode": full_decode,
        "audited_books": audited,
        "worst_status": worst_status(statuses),
        "counts": counts,
    }


@router.post("/books/{book_id}/audio-health/repair")
async def repair_book_audio(
    book_id: UUID,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    if not book.has_audiobook:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not an audiobook")

    audio_files = get_audio_files(book) or ([book.file_path] if book.file_path else [])
    if not audio_files:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No audio files for this book")

    track_results = []
    for path in audio_files:
        if not os.path.isfile(path):
            track_results.append({"path": path, "status": "missing"})
            continue
        repair = await asyncio.to_thread(resolve_repair_path, path)
        track_results.append(
            {
                "path": path,
                "status": "ok" if repair is not None else "failed",
                "repair_path": repair,
            }
        )

    hls_playlist = None
    try:
        hls_playlist = await rebuild_hls_playlist(book)
    except Exception:
        pass

    health = await asyncio.to_thread(check_book, book)
    repaired_at = _now_iso()
    metadata = dict(book.extra_metadata or {})
    metadata["audio_health"] = {
        **health,
        "repair": {"repaired_at": repaired_at, "tracks": track_results, "hls_playlist": hls_playlist},
    }
    book.extra_metadata = metadata
    await db.commit()

    return {
        "book_id": str(book.id),
        "tracks": track_results,
        "hls_playlist": hls_playlist,
        "health": metadata["audio_health"],
    }