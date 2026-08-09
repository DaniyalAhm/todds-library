from __future__ import annotations

import os
import asyncio
import logging
import shutil
import time
from enum import Enum
from pathlib import Path
from typing import Callable, TypeVar
from uuid import UUID

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from pydantic import RootModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.database import AsyncSessionLocal
from app.dependencies import get_db, require_admin
from app.models.settings import SystemSetting
from app.models.book import Book
from app.models.chapter import Chapter
from app.models.subtitle import SubtitleMetadata
from app.models.generation_log import GenerationLog
from app.models.user import User
from app.services import asr_service, chapter_service
from app.services.asr_service import ASRError, transcribe_chapter, transcribe_chapter_chunked
from app.services.chapter_service import (
    ChapterDetectionError,
    DEFAULT_GAP_THRESHOLD_SEC,
    apply_chapters_to_book,
    detect_book_chapters_sync,
)

router = APIRouter()
logger = logging.getLogger(__name__)
T = TypeVar("T")
TERMINAL_GENERATION_STATUSES = ("completed", "failed", "skipped", "cancelled")
MAX_LOG_MESSAGE_LENGTH = 500


class GenerationState(str, Enum):
    IDLE = "idle"
    BULK_RUNNING = "bulk_running"
    AUTO_RUNNING = "auto_running"
    CANCELLING = "cancelling"
    BULK_CHAPTERS_RUNNING = "bulk_chapters_running"


_generation_state: GenerationState = GenerationState.IDLE

_ACTION_NAMES = {
    GenerationState.BULK_RUNNING: "start bulk generation",
    GenerationState.AUTO_RUNNING: "start auto generation",
    GenerationState.CANCELLING: "cancel generation",
    GenerationState.BULK_CHAPTERS_RUNNING: "start bulk chapter detection",
}


def _set_state(new: GenerationState, *allowed: GenerationState) -> None:
    global _generation_state
    if _generation_state not in allowed:
        action = _ACTION_NAMES.get(new, "change state")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot {action} while state is '{_generation_state.value}'",
        )
    _generation_state = new


def _is_running() -> bool:
    return _generation_state not in (GenerationState.IDLE,)


class SettingsBody(RootModel[dict[str, str]]):
    pass


def _settings_response(db_settings: dict) -> dict:
    return {
        "asr_device": db_settings.get("asr_device", "auto"),
        "asr_gpu_index": db_settings.get("asr_gpu_index", "0"),
        "asr_compute_type": db_settings.get("asr_compute_type", "float32"),
        "asr_model_id": asr_service._normalize_model_id(db_settings.get("asr_model_id", "small")),
        "subtitle_gen_mode": db_settings.get("subtitle_gen_mode", "manual"),
        "auto_gen_language": db_settings.get("auto_gen_language", "auto"),
        "batch_size": db_settings.get("batch_size", "1"),
        "chunk_length_s": db_settings.get("chunk_length_s", "30"),
        "vad_filter": db_settings.get("vad_filter", "false"),
        "chapter_gap_threshold_sec": db_settings.get("chapter_gap_threshold_sec", "3.0"),
    }


@router.get("/settings")
async def get_settings(
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(SystemSetting))
    rows = result.scalars().all()
    db_settings = {row.key: row.value for row in rows}

    return {
        "settings": _settings_response(db_settings),
        "gpu": _gpu_status(),
    }


@router.put("/settings")
async def update_settings(
    body: SettingsBody,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    allowed_keys = {"asr_device", "asr_gpu_index", "asr_compute_type", "asr_model_id", "subtitle_gen_mode", "auto_gen_language", "batch_size", "chunk_length_s", "vad_filter", "chapter_gap_threshold_sec"}
    for key, value in body.root.items():
        if key not in allowed_keys:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Unknown setting: {key}",
            )
        if key == "asr_device" and value not in ("auto", "cuda", "cpu"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="asr_device must be 'auto', 'cuda', or 'cpu'",
            )
        if key == "asr_gpu_index":
            try:
                v = int(value)
                if v < 0:
                    raise ValueError
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="asr_gpu_index must be a non-negative integer")
        if key == "asr_compute_type" and value not in ("float16", "float32"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="asr_compute_type must be 'float16' or 'float32'",
            )
        if key == "subtitle_gen_mode" and value not in ("manual", "auto_new", "auto_all"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="subtitle_gen_mode must be 'manual', 'auto_new', or 'auto_all'",
            )
        if key == "batch_size":
            try:
                v = int(value)
                if v < 1 or v > 16:
                    raise ValueError
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="batch_size must be an integer 1-16")
        if key == "chunk_length_s":
            try:
                v = int(value)
                if v < 10 or v > 120:
                    raise ValueError
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="chunk_length_s must be an integer 10-120")
        if key == "vad_filter" and value not in ("true", "false"):
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="vad_filter must be 'true' or 'false'")
        if key == "chapter_gap_threshold_sec":
            try:
                v = float(value)
                if v <= 0:
                    raise ValueError
            except ValueError:
                raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="chapter_gap_threshold_sec must be a positive number")

    for key, value in body.root.items():
        existing = await db.execute(
            select(SystemSetting).where(SystemSetting.key == key)
        )
        row = existing.scalar_one_or_none()
        if row is not None:
            row.value = value
        else:
            db.add(SystemSetting(key=key, value=value))

    await db.commit()

    asr_service.apply_runtime_settings(body.root)

    from app.config import settings as app_settings
    if "subtitle_gen_mode" in body.root:
        app_settings.subtitle_gen_mode = body.root["subtitle_gen_mode"]
    if "auto_gen_language" in body.root:
        app_settings.auto_gen_language = body.root["auto_gen_language"]
    if "batch_size" in body.root:
        os.environ["BATCH_SIZE"] = body.root["batch_size"]
        app_settings.batch_size = int(body.root["batch_size"])
    if "chunk_length_s" in body.root:
        os.environ["CHUNK_LENGTH_S"] = body.root["chunk_length_s"]
        app_settings.chunk_length_s = int(body.root["chunk_length_s"])
    if "vad_filter" in body.root:
        os.environ["VAD_FILTER"] = body.root["vad_filter"]
        app_settings.vad_filter = body.root["vad_filter"] == "true"

    result = await db.execute(select(SystemSetting))
    rows = result.scalars().all()
    db_settings = {row.key: row.value for row in rows}

    return {
        "settings": _settings_response(db_settings),
        "gpu": _gpu_status(),
    }


@router.post("/settings/generate-all-subtitles")
async def generate_all_subtitles(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_admin),
):
    _set_state(GenerationState.BULK_RUNNING, GenerationState.IDLE)
    background_tasks.add_task(_generate_all_subtitles_bg)
    return {"status": "started", "message": "Subtitle generation started in the background", "running": True}


@router.post("/settings/generate-all-chapters")
async def generate_all_chapters(
    background_tasks: BackgroundTasks,
    current_user: User = Depends(require_admin),
):
    _set_state(GenerationState.BULK_CHAPTERS_RUNNING, GenerationState.IDLE)
    background_tasks.add_task(_generate_all_chapters_bg)
    return {"status": "started", "message": "Chapter detection started in the background", "running": True}


@router.post("/settings/cancel-generation")
async def cancel_generation(
    current_user: User = Depends(require_admin),
):
    _set_state(
        GenerationState.CANCELLING,
        GenerationState.BULK_RUNNING,
        GenerationState.AUTO_RUNNING,
        GenerationState.BULK_CHAPTERS_RUNNING,
    )
    return {"status": "cancelling", "message": "Generation will stop after the current chapter", "running": True}


@router.get("/settings/generation-logs")
async def get_generation_logs(
    limit: int = 100,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(GenerationLog).order_by(GenerationLog.created_at.desc()).limit(limit)
    )
    rows = result.scalars().all()
    return {
        "running": _is_running(),
        "logs": [
            {
                "id": str(r.id),
                "book_id": str(r.book_id) if r.book_id else None,
                "chapter_id": str(r.chapter_id) if r.chapter_id else None,
                "chapter_index": r.chapter_index,
                "book_title": r.book_title,
                "status": r.status,
                "message": r.message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in reversed(rows)
        ]
    }


async def _add_log(
    db: AsyncSession,
    book_id: UUID | str | None,
    chapter_id: UUID | str | None,
    chapter_index: int | None,
    book_title: str | None,
    status: str,
    message: str | None,
) -> None:
    logger.info(
        "Generation log: status=%s book=%s chapter=%s message=%s",
        status,
        book_title or book_id,
        chapter_index if chapter_index is not None else chapter_id,
        message,
    )
    db.add(GenerationLog(
        book_id=UUID(book_id) if isinstance(book_id, str) and book_id else book_id,
        chapter_id=UUID(chapter_id) if isinstance(chapter_id, str) and chapter_id else chapter_id,
        chapter_index=chapter_index,
        book_title=book_title,
        status=status,
        message=message,
    ))
    await db.commit()


def _generation_error_message(exc: BaseException, prefix: str | None = None) -> str:
    detail = str(exc).strip() or exc.__class__.__name__
    message = f"{exc.__class__.__name__}: {detail}"
    if prefix:
        message = f"{prefix}: {message}"
    return message[:MAX_LOG_MESSAGE_LENGTH]


def _format_range_time(seconds: float) -> str:
    total_seconds = int(seconds)
    h = total_seconds // 3600
    m = (total_seconds % 3600) // 60
    s = total_seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def _clear_chapter_partials(subtitles_dir: Path, chapter_index: int) -> None:
    partial_dir = Path(subtitles_dir) / ".partials" / f"chapter_{chapter_index:04d}"
    if partial_dir.exists():
        shutil.rmtree(partial_dir, ignore_errors=True)


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


async def _run_with_transcription_heartbeats(
    db: AsyncSession,
    work: Callable[[], T],
    *,
    book_id: UUID | str | None,
    chapter_id: UUID | str | None,
    chapter_index: int | None,
    book_title: str | None,
    heartbeat_interval_sec: int = 30,
) -> T:
    loop = asyncio.get_running_loop()
    future = loop.run_in_executor(None, work)
    started_at = time.monotonic()

    while True:
        done, _ = await asyncio.wait({future}, timeout=heartbeat_interval_sec)
        if done:
            return future.result()

        elapsed = int(time.monotonic() - started_at)
        await _add_log(
            db,
            book_id,
            chapter_id,
            chapter_index,
            book_title,
            "progress",
            f"Still transcribing... {elapsed}s elapsed",
        )


async def recover_interrupted_generation_logs() -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(GenerationLog)
            .where(GenerationLog.status == "started")
            .order_by(
                GenerationLog.book_id,
                GenerationLog.chapter_id,
                GenerationLog.created_at.desc(),
            )
        )
        started_logs = result.scalars().all()
        latest_by_target: dict[tuple[UUID | None, UUID | None], GenerationLog] = {}
        for started in started_logs:
            key = (started.book_id, started.chapter_id)
            if key not in latest_by_target:
                latest_by_target[key] = started

        recovered = False
        for started in latest_by_target.values():
            terminal_result = await db.execute(
                select(GenerationLog.id)
                .where(
                    GenerationLog.book_id.is_not_distinct_from(started.book_id),
                    GenerationLog.chapter_id.is_not_distinct_from(started.chapter_id),
                    GenerationLog.created_at > started.created_at,
                    GenerationLog.status.in_(TERMINAL_GENERATION_STATUSES),
                )
                .limit(1)
            )
            if terminal_result.scalar_one_or_none() is not None:
                continue

            db.add(GenerationLog(
                book_id=started.book_id,
                chapter_id=started.chapter_id,
                chapter_index=started.chapter_index,
                book_title=started.book_title,
                status="failed",
                message="Generation interrupted before completion.",
            ))
            recovered = True

        if recovered:
            await db.commit()


async def _generate_all_subtitles_bg() -> None:
    global _generation_state
    async with AsyncSessionLocal() as db:
        try:
            try:
                result = await db.execute(select(SystemSetting))
                rows = result.scalars().all()
                db_settings = {row.key: row.value for row in rows}
                asr_service.apply_runtime_settings(db_settings)
                language = None if db_settings.get("auto_gen_language", "auto") == "auto" else db_settings.get("auto_gen_language")
                batch_size = int(db_settings.get("batch_size", "1"))
                chunk_length_s = int(db_settings.get("chunk_length_s", "30"))
                vad_filter = db_settings.get("vad_filter", "false") == "true"
            except Exception:
                logger.exception("Failed to load subtitle generation settings; using defaults")
                language = None
                batch_size = 1
                chunk_length_s = 30
                vad_filter = False

            result = await db.execute(
                select(Book).options(selectinload(Book.chapters)).where(Book.file_format.in_([
                    "mp3", "m4b", "flac", "ogg", "aac", "wma"
                ]))
            )
            books = list(result.scalars().all())
            total = len(books)
            logger.info(
                "Bulk generation starting: books=%s batch_size=%s chunk_length_s=%s vad_filter=%s",
                total,
                batch_size,
                chunk_length_s,
                vad_filter,
            )

            for book_idx, book in enumerate(books, 1):
                if _generation_state == GenerationState.CANCELLING:
                    await _add_log(db, book.id, None, None, book.title or Path(book.file_path).stem, "cancelled", "Generation cancelled by user")
                    logger.info("Bulk generation cancelled after book %s/%s", book_idx - 1, total)
                    return

                audio_files = (book.extra_metadata or {}).get("audio_files", [])
                book_title = book.title or Path(book.file_path).stem
                chapters_list = book.chapters
                logger.info(
                    'Bulk generation book %s/%s "%s": chapters=%s',
                    book_idx,
                    total,
                    book_title,
                    len(chapters_list),
                )
                for chapter in chapters_list:
                    if _generation_state == GenerationState.CANCELLING:
                        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "cancelled", "Generation cancelled by user")
                        logger.info('Bulk generation cancelled at "%s" chapter %s', book_title, chapter.index)
                        return

                    existing = await db.execute(
                        select(SubtitleMetadata).where(SubtitleMetadata.chapter_id == chapter.id)
                    )
                    if existing.scalar_one_or_none() is not None:
                        await _add_log(db, book.id, chapter.id, chapter.index, book_title, "skipped", "Subtitles already exist")
                        logger.info('Bulk generation skipped "%s" chapter %s: subtitles exist', book_title, chapter.index)
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
                        logger.warning('Bulk generation failed "%s" chapter %s: audio file not found', book_title, chapter.index)
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
                    logger.info('Bulk generation transcribing "%s" chapter %s from %s', book_title, chapter.index, audio_path)

                    try:
                        sub_result = await _run_with_transcription_heartbeats(
                            db,
                            lambda: (
                                transcribe_chapter_chunked(
                                    audio_path,
                                    str(subtitles_dir),
                                    chapter.index or 0,
                                    language,
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
                                    language,
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
                        logger.exception('Bulk generation failed "%s" chapter %s', book_title, chapter.index)
                        continue
        except Exception as e:
            await _add_log(db, None, None, None, None, "failed", _generation_error_message(e, "Bulk generation crashed"))
            logger.exception("Bulk generation crashed")
        finally:
            logger.info("Bulk generation finished")
            _generation_state = GenerationState.IDLE


async def _generate_all_chapters_bg() -> None:
    global _generation_state
    async with AsyncSessionLocal() as db:
        try:
            try:
                result = await db.execute(select(SystemSetting))
                rows = result.scalars().all()
                db_settings = {row.key: row.value for row in rows}
                asr_service.apply_runtime_settings(db_settings)
                language = None if db_settings.get("auto_gen_language", "auto") == "auto" else db_settings.get("auto_gen_language")
                batch_size = int(db_settings.get("batch_size", "1"))
                chunk_length_s = int(db_settings.get("chunk_length_s", "30"))
                vad_filter = db_settings.get("vad_filter", "false") == "true"
                try:
                    gap_threshold_sec = float(db_settings.get("chapter_gap_threshold_sec", DEFAULT_GAP_THRESHOLD_SEC))
                except (TypeError, ValueError):
                    gap_threshold_sec = DEFAULT_GAP_THRESHOLD_SEC
            except Exception:
                logger.exception("Failed to load chapter detection settings; using defaults")
                language = None
                batch_size = 1
                chunk_length_s = 30
                vad_filter = False
                gap_threshold_sec = DEFAULT_GAP_THRESHOLD_SEC

            result = await db.execute(
                select(Book)
                .options(selectinload(Book.chapters))
                .where(Book.file_format.in_(["mp3", "m4b", "flac", "ogg", "aac", "wma"]))
            )
            books = list(result.scalars().all())
            total = len(books)
            logger.info(
                "Bulk chapter detection starting: books=%s gap_threshold_sec=%s",
                total,
                gap_threshold_sec,
            )

            for book_idx, book in enumerate(books, 1):
                if _generation_state == GenerationState.CANCELLING:
                    await _add_log(db, book.id, None, None, book.title or Path(book.file_path).stem, "cancelled", "Chapter detection cancelled by user")
                    logger.info("Bulk chapter detection cancelled after book %s/%s", book_idx - 1, total)
                    return

                book_title = book.title or Path(book.file_path).stem
                audio_files = (book.extra_metadata or {}).get("audio_files", [])
                if len(audio_files) > 1:
                    await _add_log(db, book.id, None, None, book_title, "skipped", "Multi-track audiobook already has per-track chapters")
                    continue
                if len(book.chapters or []) > 1:
                    await _add_log(db, book.id, None, None, book_title, "skipped", "Already has chapters")
                    continue

                logger.info('Bulk chapter detection book %s/%s "%s"', book_idx, total, book_title)
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
                await _add_log(db, book.id, None, None, book_title, "started", "Detecting chapters from whisper timestamps...")
                try:
                    result = await _run_with_transcription_heartbeats(
                        db,
                        lambda: detect_book_chapters_sync(
                            book,
                            gap_threshold_sec=gap_threshold_sec,
                            language=language,
                            batch_size=batch_size,
                            chunk_length_s=chunk_length_s,
                            vad_filter=vad_filter,
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
                        overwrite=False,
                        duration=result["duration"],
                    )
                    await _add_log(db, book.id, None, None, book_title, "completed", f"Detected {len(result['chapters'])} chapters")
                except ChapterDetectionError as e:
                    await _add_log(db, book.id, None, None, book_title, "failed", str(e))
                except (ASRError, Exception) as e:
                    await _add_log(db, book.id, None, None, book_title, "failed", _generation_error_message(e, "Chapter detection failed"))
                    logger.exception('Bulk chapter detection failed "%s"', book_title)
        except Exception as e:
            await _add_log(db, None, None, None, None, "failed", _generation_error_message(e, "Bulk chapter detection crashed"))
            logger.exception("Bulk chapter detection crashed")
        finally:
            logger.info("Bulk chapter detection finished")
            _generation_state = GenerationState.IDLE


def _resolve_chapter_audio(audio_files: list[str], book_file_path: str, chapter_index: int | None) -> str | None:
    if len(audio_files) > 1 and chapter_index is not None and 1 <= chapter_index <= len(audio_files):
        return audio_files[chapter_index - 1]
    return book_file_path


def _gpu_status() -> dict:
    try:
        import torch

        if torch.cuda.is_available():
            devices = [
                {
                    "index": idx,
                    "name": torch.cuda.get_device_name(idx),
                    "compute_capability": ".".join(str(part) for part in torch.cuda.get_device_capability(idx)),
                }
                for idx in range(torch.cuda.device_count())
            ]
            return {
                "available": True,
                "device_count": torch.cuda.device_count(),
                "device_name": torch.cuda.get_device_name(0),
                "devices": devices,
                "driver_version": torch.version.cuda or "unknown",
            }
        return {"available": False, "device_count": 0, "device_name": None, "devices": [], "driver_version": None}
    except Exception:
        return {"available": False, "device_count": 0, "device_name": None, "devices": [], "driver_version": None}
