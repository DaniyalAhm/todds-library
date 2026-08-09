from __future__ import annotations

import os
import asyncio
import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db
from app.models.book import Book
from app.models.chapter import Chapter
from app.models.settings import SystemSetting
from app.models.user import User
from app.models.subtitle import SubtitleMetadata
from app.services import asr_service
from app.services.asr_service import ASRError, transcribe_chapter, transcribe_chapter_chunked
from app.services.book_service import get_book_for_user
from app.api.settings import (
    _add_log,
    _clear_chapter_partials,
    _generation_error_message,
    _run_with_transcription_heartbeats,
)


logger = logging.getLogger(__name__)


async def _load_tc(db: AsyncSession) -> dict:
    result = await db.execute(select(SystemSetting))
    rows = result.scalars().all()
    s = {row.key: row.value for row in rows}
    asr_service.apply_runtime_settings(s)
    return {
        "language": None if s.get("auto_gen_language", "auto") == "auto" else s.get("auto_gen_language"),
        "batch_size": int(s.get("batch_size", "1")),
        "chunk_length_s": int(s.get("chunk_length_s", "30")),
        "vad_filter": s.get("vad_filter", "false") == "true",
    }


def _resolve_chapter_audio(book: Book, chapter: Chapter) -> str:
    metadata = book.extra_metadata or {}
    audio_files = metadata.get("audio_files", [])
    if len(audio_files) > 1 and chapter.index is not None and 1 <= chapter.index <= len(audio_files):
        return audio_files[chapter.index - 1]
    return book.file_path


def _subtitle_dir(book: Book) -> Path:
    return Path(book.file_path).parent / "subtitles" / str(book.id)


def _is_full_source_transcription(book: Book) -> bool:
    audio_files = (book.extra_metadata or {}).get("audio_files", [])
    return len(book.chapters or []) == 1 and len(audio_files) <= 1


def _audio_source_count(book: Book) -> int:
    audio_files = (book.extra_metadata or {}).get("audio_files", [])
    if isinstance(audio_files, list) and audio_files:
        return len(audio_files)
    return 1


def _format_range_time(seconds: float) -> str:
    total_seconds = int(seconds)
    h = total_seconds // 3600
    m = (total_seconds % 3600) // 60
    s = total_seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def _chunk_progress_logger(db: AsyncSession, book: Book, chapter: Chapter, book_title: str):
    loop = asyncio.get_running_loop()

    def log_progress(chunk_number: int, total_chunks: int, start_sec: float, end_sec: float) -> None:
        future = asyncio.run_coroutine_threadsafe(
            _add_log(
                db,
                book.id,
                chapter.id,
                chapter.index,
                book_title,
                "progress",
                f"Transcribed chunk {chunk_number}/{total_chunks} ({_format_range_time(start_sec)}-{_format_range_time(end_sec)})",
            ),
            loop,
        )
        future.result()

    return log_progress


router = APIRouter()


@router.post("/books/{book_id}/chapters/{chapter_id}/transcribe")
async def transcribe_chapter_endpoint(
    book_id: UUID,
    chapter_id: UUID,
    overwrite: bool = Query(False),
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

    if overwrite and not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required to regenerate subtitles",
        )

    existing_sub = await db.execute(
        select(SubtitleMetadata).where(SubtitleMetadata.chapter_id == chapter_id)
    )
    has_existing = existing_sub.scalar_one_or_none() is not None
    if has_existing and not overwrite:
        await _add_log(
            db,
            book.id,
            chapter.id,
            chapter.index,
            book.title or Path(book.file_path).stem,
            "skipped",
            "Subtitles already exist",
        )
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Subtitles already exist for this chapter",
        )

    audio_path = _resolve_chapter_audio(book, chapter)
    if not audio_path or not os.path.isfile(audio_path):
        await _add_log(
            db,
            book.id,
            chapter.id,
            chapter.index,
            book.title or Path(book.file_path).stem,
            "failed",
            f"Audio file not found: {audio_path or 'unresolved'}",
        )
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No audio file for this chapter")

    tc = await _load_tc(db)
    subtitles_dir = _subtitle_dir(book)
    subtitles_dir.mkdir(parents=True, exist_ok=True)
    book_title = book.title or Path(book.file_path).stem

    if overwrite and has_existing:
        _clear_chapter_partials(subtitles_dir, chapter.index or 0)
        await _add_log(
            db,
            book.id,
            chapter.id,
            chapter.index,
            book_title,
            "started",
            "Regenerating subtitles (overwriting existing)...",
        )

    use_chunked = asr_service.should_use_chunked_transcription(
        audio_source_count=_audio_source_count(book),
        chapter_count=len(book.chapters or []),
        audio_path=audio_path,
        duration_sec=book.duration,
    )
    chunk_progress = _chunk_progress_logger(db, book, chapter, book_title) if use_chunked else None
    start_message = (
        f"Transcribing full source file in 30-minute chunks: {Path(audio_path).name}"
        if use_chunked
        else f"Transcribing full source file: {Path(audio_path).name}"
        if _is_full_source_transcription(book)
        else "Transcribing..."
    )
    await _add_log(db, book.id, chapter.id, chapter.index, book_title, "started", start_message)

    try:
        sub_result = await _run_with_transcription_heartbeats(
            db,
            lambda: (
                transcribe_chapter_chunked(
                    audio_path,
                    str(subtitles_dir),
                    chapter.index or 0,
                    tc["language"],
                    tc["batch_size"],
                    tc["chunk_length_s"],
                    tc["vad_filter"],
                    book.duration,
                    progress_callback=chunk_progress,
                )
                if use_chunked
                else transcribe_chapter(
                    audio_path,
                    str(subtitles_dir),
                    chapter.index or 0,
                    tc["language"],
                    tc["batch_size"],
                    tc["chunk_length_s"],
                    tc["vad_filter"],
                )
            ),
            book_id=book.id,
            chapter_id=chapter.id,
            chapter_index=chapter.index,
            book_title=book_title,
        )
        await _add_log(
            db,
            book.id,
            chapter.id,
            chapter.index,
            book_title,
            "progress",
            "Transcription finished; saving subtitle metadata...",
        )

        existing_sub = await db.execute(
            select(SubtitleMetadata).where(SubtitleMetadata.chapter_id == chapter_id)
        )
        row = existing_sub.scalar_one_or_none()
        if row is not None:
            row.language = sub_result.language
            row.model_id = sub_result.model_id
            row.json_path = sub_result.json_path
            row.srt_path = sub_result.srt_path
            row.vtt_path = sub_result.vtt_path
            row.cue_count = sub_result.cue_count
            row.word_count = sub_result.word_count
            row.duration_sec = sub_result.duration_sec
            row.status = "completed"
        else:
            db.add(
                SubtitleMetadata(
                    chapter_id=chapter.id,
                    book_id=book.id,
                    language=sub_result.language,
                    model_id=sub_result.model_id,
                    status="completed",
                    json_path=sub_result.json_path,
                    srt_path=sub_result.srt_path,
                    vtt_path=sub_result.vtt_path,
                    cue_count=sub_result.cue_count,
                    word_count=sub_result.word_count,
                    duration_sec=sub_result.duration_sec,
                )
            )
        await db.commit()

        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "completed", f"{sub_result.cue_count} cues, {sub_result.word_count} words")
        return {"status": "completed", "subtitle_path": sub_result.srt_path}
    except (ASRError, Exception) as e:
        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "failed", _generation_error_message(e, "Transcription failed"))
        logger.exception('Manual transcription failed for "%s" chapter %s', book_title, chapter.index)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))


@router.get("/books/{book_id}/chapters/{chapter_id}/subtitles")
async def get_chapter_subtitles(
    book_id: UUID,
    chapter_id: UUID,
    format: str = Query("srt", pattern="^(srt|vtt|json)$"),
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

    # Try to resolve subtitle path from database metadata first
    meta_result = await db.execute(
        select(SubtitleMetadata).where(SubtitleMetadata.chapter_id == chapter_id)
    )
    metadata = meta_result.scalar_one_or_none()

    ext = format if format in ("vtt", "json") else "srt"

    subtitle_path: Path | None = None
    if metadata is not None:
        path_str = {
            "json": metadata.json_path,
            "vtt": metadata.vtt_path,
            "srt": metadata.srt_path,
        }.get(ext)
        if path_str and Path(path_str).exists():
            subtitle_path = Path(path_str)

    # Fall back to constructing path from book file location
    if subtitle_path is None:
        fallback = _subtitle_dir(book) / f"chapter_{chapter.index or 0:04d}.{ext}"
        if fallback.exists():
            subtitle_path = fallback

    if subtitle_path is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Subtitles not yet generated")

    from fastapi.responses import FileResponse

    media_type = {
        "json": "application/json",
        "vtt": "text/vtt",
        "srt": "application/x-subrip",
    }[ext]
    return FileResponse(str(subtitle_path), media_type=media_type)
