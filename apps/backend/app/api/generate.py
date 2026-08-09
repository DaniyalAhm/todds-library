from __future__ import annotations

import os
import asyncio
import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db
from app.models.book import Book
from app.models.chapter import Chapter
from app.models.settings import SystemSetting
from app.models.subtitle import SubtitleMetadata
from app.models.user import User
from app.services import asr_service, chapter_service
from app.services.asr_service import ASRError, SubtitleResult, transcribe_chapter, transcribe_chapter_chunked
from app.services.audiobook_service import get_audio_files
from app.services.book_service import get_book_for_user
from app.services.chapter_service import (
    ChapterDetectionError,
    DEFAULT_GAP_THRESHOLD_SEC,
    apply_chapters_to_book,
    detect_book_chapters_sync,
)
from app.api.settings import (
    _add_log,
    _clear_chapter_partials,
    _generation_error_message,
    _run_with_transcription_heartbeats,
)


logger = logging.getLogger(__name__)


async def _load_transcribe_settings(db: AsyncSession) -> dict:
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


async def _save_subtitle_metadata(
    db: AsyncSession,
    book_id: UUID,
    chapter_id: UUID,
    result: SubtitleResult,
) -> None:
    existing = await db.execute(
        select(SubtitleMetadata).where(SubtitleMetadata.chapter_id == chapter_id)
    )
    row = existing.scalar_one_or_none()
    if row is not None:
        row.language = result.language
        row.model_id = result.model_id
        row.json_path = result.json_path
        row.srt_path = result.srt_path
        row.vtt_path = result.vtt_path
        row.cue_count = result.cue_count
        row.word_count = result.word_count
        row.duration_sec = result.duration_sec
        row.status = "completed"
    else:
        db.add(
            SubtitleMetadata(
                chapter_id=chapter_id,
                book_id=book_id,
                language=result.language,
                model_id=result.model_id,
                status="completed",
                json_path=result.json_path,
                srt_path=result.srt_path,
                vtt_path=result.vtt_path,
                cue_count=result.cue_count,
                word_count=result.word_count,
                duration_sec=result.duration_sec,
            )
        )
    await db.commit()


router = APIRouter()


class GenerateSubtitlesRequest(BaseModel):
    chapter_ids: list[UUID] | None = None
    overwrite: bool = False


class GenerateChaptersRequest(BaseModel):
    overwrite: bool = False
    gap_threshold_sec: float = Field(DEFAULT_GAP_THRESHOLD_SEC, gt=0)


@router.post("/books/{book_id}/chapters/{chapter_id}/generate/subtitles")
async def generate_chapter_subtitles(
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

    tc = await _load_transcribe_settings(db)
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
        await _save_subtitle_metadata(db, book.id, chapter.id, sub_result)
        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "completed", f"{sub_result.cue_count} cues, {sub_result.word_count} words")
        return {"status": "completed", "subtitle_path": sub_result.srt_path, "chapter_id": str(chapter_id)}
    except (ASRError, Exception) as e:
        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "failed", _generation_error_message(e, "Transcription failed"))
        logger.exception('Manual subtitle generation failed for "%s" chapter %s', book_title, chapter.index)
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
        await _add_log(db, book.id, None, None, book.title or Path(book.file_path).stem, "failed", "No chapters found")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No chapters found")

    overwrite = bool(req and req.overwrite)
    if overwrite and not current_user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin access required to regenerate subtitles",
        )

    tc = await _load_transcribe_settings(db)
    subtitles_dir = _subtitle_dir(book)
    subtitles_dir.mkdir(parents=True, exist_ok=True)
    book_title = book.title or Path(book.file_path).stem

    completed = []
    for chapter in chapters:
        existing_sub = await db.execute(
            select(SubtitleMetadata).where(SubtitleMetadata.chapter_id == chapter.id)
        )
        has_existing = existing_sub.scalar_one_or_none() is not None
        if has_existing and not overwrite:
            await _add_log(db, book.id, chapter.id, chapter.index, book_title, "skipped", "Subtitles already exist")
            completed.append({"chapter_id": str(chapter.id), "status": "skipped"})
            continue

        audio_path = _resolve_chapter_audio(book, chapter)
        if not audio_path or not os.path.isfile(audio_path):
            message = f"Audio file not found: {audio_path or 'unresolved'}"
            await _add_log(db, book.id, chapter.id, chapter.index, book_title, "failed", message)
            completed.append({"chapter_id": str(chapter.id), "status": "failed", "error": message})
            continue

        if overwrite and has_existing:
            _clear_chapter_partials(subtitles_dir, chapter.index or 0)

        use_chunked = asr_service.should_use_chunked_transcription(
            audio_source_count=_audio_source_count(book),
            chapter_count=len(chapters),
            audio_path=audio_path,
            duration_sec=book.duration,
        )
        chunk_progress = _chunk_progress_logger(db, book, chapter, book_title) if use_chunked else None
        start_message = (
            f"Transcribing full source file in 30-minute chunks: {Path(audio_path).name}"
            if use_chunked
            else f"Transcribing full source file: {Path(audio_path).name}"
            if len(chapters) == 1 and _is_full_source_transcription(book)
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
            await _save_subtitle_metadata(db, book.id, chapter.id, sub_result)
            await _add_log(db, book.id, chapter.id, chapter.index, book_title, "completed", f"{sub_result.cue_count} cues, {sub_result.word_count} words")
            completed.append({"chapter_id": str(chapter.id), "status": "completed", "subtitle_path": sub_result.srt_path})
        except (ASRError, Exception) as e:
            message = _generation_error_message(e, "Transcription failed")
            await _add_log(db, book.id, chapter.id, chapter.index, book_title, "failed", message)
            logger.exception('Manual bulk subtitle generation failed for "%s" chapter %s', book_title, chapter.index)
            completed.append({"chapter_id": str(chapter.id), "status": "failed", "error": message})

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

    subtitles_dir = _subtitle_dir(book)
    if not subtitles_dir.exists():
        return {"book_id": str(book_id), "generated_chapters": []}

    generated = []
    for f in sorted(subtitles_dir.glob("chapter_*.srt")):
        chapter_idx = int(f.stem.split("_")[1])
        generated.append({"chapter_index": chapter_idx, "format": "srt", "path": str(f)})

    return {"book_id": str(book_id), "generated_chapters": generated}


@router.post("/books/{book_id}/generate/chapters")
async def generate_book_chapters(
    book_id: UUID,
    req: GenerateChaptersRequest | None = None,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    if not book.has_audiobook:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Not an audiobook")

    audio_files = get_audio_files(book)
    if len(audio_files) > 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Multi-track audiobooks already have per-track chapters",
        )

    overwrite = req.overwrite if req else False
    gap_threshold_sec = req.gap_threshold_sec if req else DEFAULT_GAP_THRESHOLD_SEC
    tc = await _load_transcribe_settings(db)
    book_title = book.title or Path(book.file_path).stem

    subtitle_result = await db.execute(
        select(SubtitleMetadata)
        .where(
            SubtitleMetadata.book_id == book.id,
            SubtitleMetadata.status == "completed",
        )
        .order_by(SubtitleMetadata.cue_count.desc())
    )
    subtitle_candidates = [
        (row.json_path, row.cue_count)
        for row in subtitle_result.scalars().all()
        if row.json_path
    ]

    await _add_log(
        db,
        book.id,
        None,
        None,
        book_title,
        "started",
        (
            "Reusing existing subtitle timestamps for chapter detection "
            f"(gap threshold {gap_threshold_sec}s)..."
            if subtitle_candidates
            else f"Detecting chapters from whisper timestamps (gap threshold {gap_threshold_sec}s)..."
        ),
    )
    try:
        result = await _run_with_transcription_heartbeats(
            db,
            lambda: detect_book_chapters_sync(
                book,
                gap_threshold_sec=gap_threshold_sec,
                language=tc["language"],
                batch_size=tc["batch_size"],
                chunk_length_s=tc["chunk_length_s"],
                vad_filter=tc["vad_filter"],
                subtitle_candidates=subtitle_candidates,
            ),
            book_id=book.id,
            chapter_id=None,
            chapter_index=None,
            book_title=book_title,
        )
        await apply_chapters_to_book(
            db,
            book,
            result["chapters"],
            overwrite=overwrite,
            duration=result["duration"],
        )
        await _add_log(
            db,
            book.id,
            None,
            None,
            book_title,
            "completed",
            f"Detected {len(result['chapters'])} chapters",
        )
        return {
            "status": "completed",
            "chapter_count": len(result["chapters"]),
            "duration": result["duration"],
            "source": result["source"],
            "chapters": result["chapters"],
        }
    except ChapterDetectionError as e:
        await _add_log(db, book.id, None, None, book_title, "failed", str(e))
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(e))
    except (ASRError, Exception) as e:
        await _add_log(
            db,
            book.id,
            None,
            None,
            book_title,
            "failed",
            _generation_error_message(e, "Chapter detection failed"),
        )
        logger.exception('Chapter detection failed for "%s"', book_title)
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))
