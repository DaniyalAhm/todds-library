from __future__ import annotations

import os
import asyncio
import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from meilisearch import Client as MeiliClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import AsyncSessionLocal
from app.dependencies import get_current_user, get_db, get_meili_client, require_admin
from app.models.settings import SystemSetting
from app.models.book import Book
from app.models.chapter import Chapter
from app.models.subtitle import SubtitleMetadata
from app.models.user import User
from app.schemas.library import DirectoryList, LibraryCreate, LibraryList, LibraryResponse
from app.api import settings as settings_api
from app.api.settings import GenerationState, _add_log, _generation_error_message, _run_with_transcription_heartbeats, _set_state
from app.services import asr_service
from app.services.asr_service import ASRError, transcribe_chapter, transcribe_chapter_chunked
from app.services.library_service import (
    create_library,
    delete_library,
    get_libraries,
    get_library,
    list_library_directories,
)
from app.services.scanner_service import scan_library

router = APIRouter()
logger = logging.getLogger(__name__)


def _format_range_time(seconds: float) -> str:
    total_seconds = int(seconds)
    h = total_seconds // 3600
    m = (total_seconds % 3600) // 60
    s = total_seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def _audio_source_count(audio_files: list[str]) -> int:
    return len(audio_files) if audio_files else 1


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


@router.get("", response_model=LibraryList)
async def list_libraries(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    libraries = await get_libraries(db, current_user)
    return LibraryList(items=libraries)


@router.get("/directories", response_model=DirectoryList)
async def list_available_directories(
    path: str | None = None,
    _admin: User = Depends(require_admin),
):
    try:
        return DirectoryList(**list_library_directories(path))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


@router.post("", response_model=LibraryResponse, status_code=status.HTTP_201_CREATED)
async def create_new_library(
    data: LibraryCreate,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    meili: MeiliClient = Depends(get_meili_client),
):
    try:
        library = await create_library(db, current_user, data)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    await scan_library(db, meili, library.id)
    return library


@router.get("/{library_id}", response_model=LibraryResponse)
async def get_library_detail(
    library_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    library = await get_library(db, library_id, current_user)
    if library is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")
    return library


@router.delete("/{library_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_library(
    library_id: UUID,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    library = await get_library(db, library_id, current_user)
    if library is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")
    await delete_library(db, library_id, current_user)


@router.post("/{library_id}/scan")
async def scan_library_endpoint(
    library_id: UUID,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    meili: MeiliClient = Depends(get_meili_client),
):
    library = await get_library(db, library_id, current_user)
    if library is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")
    result = await scan_library(db, meili, library_id)

    new_ids: list[UUID] = result.get("new_ids", [])
    updated_ids: list[UUID] = result.get("updated_ids", [])

    if new_ids or updated_ids:
        settings_result = await db.execute(select(SystemSetting))
        settings_rows = settings_result.scalars().all()
        db_settings = {row.key: row.value for row in settings_rows}
        mode = db_settings.get("subtitle_gen_mode", "manual")

        if (mode == "auto_new" and new_ids) or mode == "auto_all":
            book_ids = (new_ids + updated_ids) if mode == "auto_all" else new_ids
            try:
                _set_state(GenerationState.AUTO_RUNNING, GenerationState.IDLE)
                background_tasks.add_task(_auto_generate_for_books, book_ids, db_settings.get("auto_gen_language", "auto"))
            except HTTPException:
                pass

    return {
        "task_id": str(library_id),
        "status": "completed",
        "new_books": result.get("new", 0),
        "updated_books": result.get("updated", 0),
        "removed_books": result.get("removed", 0),
    }


async def _auto_generate_for_books(book_ids: list[UUID], language: str) -> None:
    async with AsyncSessionLocal() as db:
        try:
            try:
                result = await db.execute(select(SystemSetting))
                rows = result.scalars().all()
                db_settings = {row.key: row.value for row in rows}
                asr_service.apply_runtime_settings(db_settings)
                batch_size = int(db_settings.get("batch_size", "1"))
                chunk_length_s = int(db_settings.get("chunk_length_s", "30"))
                vad_filter = db_settings.get("vad_filter", "false") == "true"
            except Exception:
                logger.exception("Failed to load subtitle auto-generation settings; using defaults")
                batch_size = 1
                chunk_length_s = 30
                vad_filter = False

            lang = language if language != "auto" else None
            logger.info(
                "Auto generation starting: books=%s batch_size=%s chunk_length_s=%s vad_filter=%s",
                len(book_ids),
                batch_size,
                chunk_length_s,
                vad_filter,
            )

            for book_idx, book_id in enumerate(book_ids, 1):
                if settings_api._generation_state == GenerationState.CANCELLING:
                    await _add_log(db, book_id, None, None, None, "cancelled", "Generation cancelled by user")
                    logger.info("Auto generation cancelled after book %s/%s", book_idx - 1, len(book_ids))
                    return

                result = await db.execute(
                    select(Book).options(selectinload(Book.chapters)).where(Book.id == book_id)
                )
                book = result.scalar_one_or_none()
                if book is None:
                    await _add_log(db, book_id, None, None, None, "failed", f"Book {book_id} not found")
                    logger.warning("Auto generation skipped book %s/%s (%s): not found", book_idx, len(book_ids), book_id)
                    continue

                book_title = book.title or Path(book.file_path).stem
                chapters_list = book.chapters
                logger.info('Auto generation book %s/%s "%s": chapters=%s', book_idx, len(book_ids), book_title, len(chapters_list))
                audio_files = (book.extra_metadata or {}).get("audio_files", [])
                for chapter in chapters_list:
                    if settings_api._generation_state == GenerationState.CANCELLING:
                        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "cancelled", "Generation cancelled by user")
                        logger.info('Auto generation cancelled at "%s" chapter %s', book_title, chapter.index)
                        return

                    existing = await db.execute(
                        select(SubtitleMetadata).where(SubtitleMetadata.chapter_id == chapter.id)
                    )
                    if existing.scalar_one_or_none() is not None:
                        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "skipped", "Subtitles already exist")
                        logger.info('Auto generation skipped "%s" chapter %s: subtitles exist', book_title, chapter.index)
                        continue

                    audio_path = _resolve_chapter_audio(audio_files, book.file_path, chapter.index)
                    if not audio_path or not os.path.isfile(audio_path):
                        await _add_log(
                            db,
                            book.id,
                            chapter.id,
                            chapter.index,
                            book_title,
                            "failed",
                            f"Audio file not found: {audio_path or 'unresolved'}",
                        )
                        logger.warning('Auto generation failed "%s" chapter %s: audio file not found', book_title, chapter.index)
                        continue

                    subtitles_dir = Path(book.file_path).parent / "subtitles" / str(book.id)
                    subtitles_dir.mkdir(parents=True, exist_ok=True)

                    use_chunked = asr_service.should_use_chunked_transcription(
                        audio_source_count=_audio_source_count(audio_files),
                        chapter_count=len(chapters_list),
                        audio_path=audio_path,
                        duration_sec=book.duration,
                    )
                    chunk_progress = _chunk_progress_logger(db, book, chapter, book_title) if use_chunked else None
                    if use_chunked:
                        start_message = f"Transcribing full source file in 30-minute chunks: {Path(audio_path).name}"
                    elif len(chapters_list) == 1 and len(audio_files) <= 1:
                        start_message = f"Transcribing full source file: {Path(audio_path).name}"
                    else:
                        start_message = "Transcribing..."

                    await _add_log(db, book.id, chapter.id, chapter.index, book_title, "started", start_message)
                    logger.info('Auto generation transcribing "%s" chapter %s from %s', book_title, chapter.index, audio_path)

                    try:
                        sub_result = await _run_with_transcription_heartbeats(
                            db,
                            lambda: (
                                transcribe_chapter_chunked(
                                    audio_path,
                                    str(subtitles_dir),
                                    chapter.index or 0,
                                    lang,
                                    batch_size,
                                    chunk_length_s,
                                    vad_filter,
                                    book.duration,
                                    progress_callback=chunk_progress,
                                )
                                if use_chunked
                                else transcribe_chapter(
                                    audio_path,
                                    str(subtitles_dir),
                                    chapter.index or 0,
                                    lang,
                                    batch_size,
                                    chunk_length_s,
                                    vad_filter,
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

                        existing = await db.execute(
                            select(SubtitleMetadata).where(SubtitleMetadata.chapter_id == chapter.id)
                        )
                        row = existing.scalar_one_or_none()
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
                    except (ASRError, Exception) as e:
                        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "failed", _generation_error_message(e, "Transcription failed"))
                        logger.exception('Auto generation failed "%s" chapter %s', book_title, chapter.index)
                        continue
        except Exception as e:
            await _add_log(db, None, None, None, None, "failed", _generation_error_message(e, "Auto generation crashed"))
            logger.exception("Auto generation crashed")
        finally:
            settings_api._generation_state = GenerationState.IDLE


def _resolve_chapter_audio(audio_files: list[str], book_file_path: str, chapter_index: int | None) -> str | None:
    if len(audio_files) > 1 and chapter_index is not None and 1 <= chapter_index <= len(audio_files):
        return audio_files[chapter_index - 1]
    return book_file_path
