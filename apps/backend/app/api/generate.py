from __future__ import annotations

import os
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db
from app.models.book import Book
from app.models.generated_audio import GeneratedAudio
from app.models.user import User
from app.schemas.generated_audio import (
    GenerateAudioRequest,
    GenerateAudioResponse,
)
from app.services.book_service import get_book_for_user
from app.services.tts_service import TTSError, generate_book_audio

router = APIRouter()


@router.post("/books/{book_id}/generate/audio", response_model=list[GenerateAudioResponse], status_code=status.HTTP_201_CREATED)
async def generate_audio(
    book_id: UUID,
    req: GenerateAudioRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    if not book.file_path or not os.path.isfile(book.file_path):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Book file not found on disk")

    if book.file_format.value not in ("epub",):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Only EPUB books support audio generation")

    try:
        results = await generate_book_audio(
            book_id=book.id,
            book_path=book.file_path,
            voice_id=req.voice_id,
            chapter_indices=req.chapter_indices,
        )
    except TTSError as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    created = []
    for r in results:
        audio = GeneratedAudio(
            book_id=book.id,
            user_id=current_user.id,
            chapter_index=r["chapter_index"],
            voice_id=req.voice_id,
            file_path=r["file_path"],
            duration=r["duration"],
            status="completed",
        )
        db.add(audio)
        created.append(audio)
    await db.commit()
    for a in created:
        await db.refresh(a)
    return created


@router.get("/books/{book_id}/generate/audio", response_model=list[GenerateAudioResponse])
async def list_generated_audio(
    book_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    result = await db.execute(
        select(GeneratedAudio)
        .where(GeneratedAudio.book_id == book_id, GeneratedAudio.user_id == current_user.id)
        .order_by(GeneratedAudio.chapter_index)
    )
    return list(result.scalars().all())


@router.delete("/books/{book_id}/generate/audio/{audio_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_generated_audio(
    book_id: UUID,
    audio_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(GeneratedAudio).where(
            GeneratedAudio.id == audio_id,
            GeneratedAudio.book_id == book_id,
            GeneratedAudio.user_id == current_user.id,
        )
    )
    audio = result.scalar_one_or_none()
    if audio is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Generated audio not found")

    if audio.file_path and os.path.isfile(audio.file_path):
        os.unlink(audio.file_path)

    await db.delete(audio)
    await db.commit()


@router.get("/books/{book_id}/generate/audio/download/{chapter_index}")
async def download_generated_audio(
    book_id: UUID,
    chapter_index: int,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    result = await db.execute(
        select(GeneratedAudio).where(
            GeneratedAudio.book_id == book_id,
            GeneratedAudio.chapter_index == chapter_index,
            GeneratedAudio.user_id == current_user.id,
        )
    )
    audio = result.scalar_one_or_none()
    if audio is None or not audio.file_path or not os.path.isfile(audio.file_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio not found")

    from fastapi.responses import FileResponse

    return FileResponse(audio.file_path, media_type="audio/wav")
