from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db
from app.models.book import Book
from app.models.chapter import Chapter
from app.models.user import User
from app.services.asr_service import ASRError, transcribe_chapter
from app.services.book_service import get_book_for_user

router = APIRouter()


@router.post("/books/{book_id}/chapters/{chapter_id}/transcribe")
async def transcribe_chapter_endpoint(
    book_id: UUID,
    chapter_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    result = await db.execute(
        select(Chapter).where(Chapter.id == chapter_id, Chapter.book_id == book_id)
    )
    chapter = result.scalar_one_or_none()
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")

    audio_path = book.file_path
    if not audio_path or not os.path.isfile(audio_path):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No audio file for this book")

    subtitles_dir = Path(book.file_path).parent / "subtitles" / str(book.id)
    subtitles_dir.mkdir(parents=True, exist_ok=True)

    try:
        import asyncio
        srt_path = await asyncio.to_thread(
            transcribe_chapter,
            audio_path,
            str(subtitles_dir),
            chapter.index or 0,
        )
        return {"status": "completed", "subtitle_path": str(srt_path)}
    except ASRError as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.get("/books/{book_id}/chapters/{chapter_id}/subtitles")
async def get_chapter_subtitles(
    book_id: UUID,
    chapter_id: UUID,
    format: str = Query("srt", regex="^(srt|vtt)$"),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    result = await db.execute(
        select(Chapter).where(Chapter.id == chapter_id, Chapter.book_id == book_id)
    )
    chapter = result.scalar_one_or_none()
    if chapter is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Chapter not found")

    ext = "vtt" if format == "vtt" else "srt"
    subtitles_dir = Path(book.file_path).parent / "subtitles" / str(book.id)
    subtitle_path = subtitles_dir / f"chapter_{chapter.index or 0:04d}.{ext}"

    if not subtitle_path.exists():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subtitles not yet generated")

    from fastapi.responses import FileResponse

    media_type = "text/vtt" if ext == "vtt" else "application/x-subrip"
    return FileResponse(str(subtitle_path), media_type=media_type)
