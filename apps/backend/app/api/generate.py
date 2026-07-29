from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db
from app.models.chapter import Chapter
from app.models.user import User
from app.services.asr_service import ASRError, transcribe_chapter
from app.services.book_service import get_book_for_user

router = APIRouter()


class GenerateSubtitlesRequest(BaseModel):
    chapter_ids: list[UUID] | None = None


@router.post("/books/{book_id}/chapters/{chapter_id}/generate/subtitles")
async def generate_chapter_subtitles(
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
        return {"status": "completed", "subtitle_path": srt_path, "chapter_id": str(chapter_id)}
    except ASRError as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.post("/books/{book_id}/generate/subtitles")
async def generate_all_subtitles(
    book_id: UUID,
    req: GenerateSubtitlesRequest | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    query = select(Chapter).where(Chapter.book_id == book_id)
    if req and req.chapter_ids:
        query = query.where(Chapter.id.in_(req.chapter_ids))
    query = query.order_by(Chapter.index)

    result = await db.execute(query)
    chapters = list(result.scalars().all())

    if not chapters:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No chapters found")

    subtitles_dir = Path(book.file_path).parent / "subtitles" / str(book.id)
    subtitles_dir.mkdir(parents=True, exist_ok=True)

    completed = []
    for chapter in chapters:
        audio_path = book.file_path
        if not audio_path or not os.path.isfile(audio_path):
            continue
        try:
            import asyncio
            srt_path = await asyncio.to_thread(
                transcribe_chapter,
                audio_path,
                str(subtitles_dir),
                chapter.index or 0,
            )
            completed.append({"chapter_id": str(chapter.id), "status": "completed", "subtitle_path": srt_path})
        except ASRError as e:
            completed.append({"chapter_id": str(chapter.id), "status": "failed", "error": str(e)})

    return {"status": "completed", "results": completed}


@router.get("/books/{book_id}/generate/subtitles/status")
async def get_subtitle_generation_status(
    book_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    subtitles_dir = Path(book.file_path).parent / "subtitles" / str(book.id)
    if not subtitles_dir.exists():
        return {"book_id": str(book_id), "generated_chapters": []}

    generated = []
    for f in sorted(subtitles_dir.glob("chapter_*.srt")):
        chapter_idx = int(f.stem.split("_")[1])
        generated.append({"chapter_index": chapter_idx, "format": "srt", "path": str(f)})

    return {"book_id": str(book_id), "generated_chapters": generated}
