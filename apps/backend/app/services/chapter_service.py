from __future__ import annotations

import json
import logging
import os
from pathlib import Path

from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.book import AUDIOBOOK_FORMAT_VALUES, Book
from app.models.chapter import Chapter
from app.models.generation_log import GenerationLog
from app.models.subtitle import SubtitleMetadata
from app.services import asr_service
from app.services.audiobook_service import get_audio_files

logger = logging.getLogger(__name__)

DEFAULT_GAP_THRESHOLD_SEC = 3.0
TITLE_MAX_LENGTH = 512
SENTENCE_ENDINGS = (".", "!", "?")


class ChapterDetectionError(Exception):
    pass


def detect_chapters_from_segments(
    segments: list[dict],
    gap_threshold_sec: float = DEFAULT_GAP_THRESHOLD_SEC,
) -> list[dict]:
    """Split whisper segment timestamps into chapters at silence gaps.

    Each returned chapter carries ``index``, ``title``, ``start_position`` and
    ``end_position`` expressed in seconds on the global audio timeline.
    """
    if not segments:
        return []

    ordered = sorted(segments, key=lambda s: float(s.get("start", 0.0) or 0.0))
    chapters: list[dict] = []
    current_start = float(ordered[0].get("start", 0.0) or 0.0)
    current_end = float(ordered[0].get("end", 0.0) or 0.0)
    current_text_parts = [str(ordered[0].get("text", "") or "")]

    for prev_seg, seg in zip(ordered, ordered[1:]):
        seg_start = float(seg.get("start", 0.0) or 0.0)
        seg_end = float(seg.get("end", 0.0) or 0.0)
        if seg_start - current_end >= gap_threshold_sec:
            chapters.append(
                {
                    "index": len(chapters) + 1,
                    "title": _chapter_title(" ".join(current_text_parts), len(chapters) + 1),
                    "start_position": current_start,
                    "end_position": current_end,
                }
            )
            current_start = seg_start
            current_end = seg_end
            current_text_parts = [str(seg.get("text", "") or "")]
        else:
            current_end = max(current_end, seg_end)
            current_text_parts.append(str(seg.get("text", "") or ""))

    chapters.append(
        {
            "index": len(chapters) + 1,
            "title": _chapter_title(" ".join(current_text_parts), len(chapters) + 1),
            "start_position": current_start,
            "end_position": current_end,
        }
    )
    return chapters


def _chapter_title(text: str, chapter_index: int, max_length: int = TITLE_MAX_LENGTH) -> str:
    normalized = " ".join(text.split())
    if not normalized:
        return f"Chapter {chapter_index}"

    for ending in SENTENCE_ENDINGS:
        idx = normalized.find(ending)
        if idx >= 0:
            candidate = normalized[: idx + 1].strip()
            if len(candidate) >= 12:
                return candidate[:max_length].rstrip()

    fallback = " ".join(normalized.split()[:8])
    return fallback[:max_length].rstrip() or f"Chapter {chapter_index}"


def load_subtitle_segments(
    candidates: list[tuple[str, int | None]],
) -> list[dict] | None:
    """Load whisper cue timestamps from stored subtitle JSON files.

    ``candidates`` is a list of ``(json_path, cue_count)`` pairs from
    ``SubtitleMetadata``. For single-source books every subtitle file is a
    transcription of the whole audio file, so the cues are already on the
    global timeline; the candidate with the most cues is preferred. Returns
    ``None`` when no candidate file can be read, in which case the caller
    should fall back to a full transcription.
    """
    usable: list[tuple[str, int, list[dict]]] = []
    for json_path, cue_count in candidates:
        if not json_path or not os.path.isfile(json_path):
            continue
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                payload = json.load(f)
            cues = payload.get("cues")
            if not isinstance(cues, list) or not cues:
                continue
            usable.append((json_path, cue_count or 0, cues))
        except (OSError, ValueError, TypeError):
            logger.exception("Failed to load subtitle timestamps from %s", json_path)
            continue

    if not usable:
        return None

    _, _, cues = max(usable, key=lambda item: item[1])
    return [
        {
            "start": float(cue.get("start", 0.0) or 0.0),
            "end": float(cue.get("end", 0.0) or 0.0),
            "text": cue.get("text", ""),
        }
        for cue in cues
    ]


def resolve_audio_source(book: Book) -> str | None:
    """Resolve the single audio file used for full-source transcription."""
    raw_files = (book.extra_metadata or {}).get("audio_files")
    if isinstance(raw_files, list) and len(raw_files) > 1:
        return None
    files = get_audio_files(book)
    if files:
        return files[0]
    if book.file_format.value in AUDIOBOOK_FORMAT_VALUES:
        return book.file_path
    return None


def detect_book_chapters_sync(
    book: Book,
    *,
    gap_threshold_sec: float = DEFAULT_GAP_THRESHOLD_SEC,
    language: str | None = None,
    batch_size: int = 1,
    chunk_length_s: int = 30,
    vad_filter: bool = False,
    subtitle_candidates: list[tuple[str, int | None]] | None = None,
) -> dict:
    """Derive chapter boundaries from whisper timestamps.

    Reuses cue timestamps already persisted by subtitle transcription (via
    ``subtitle_candidates``) when available, falling back to a full
    transcription otherwise. Intended to run inside a worker executor; returns
    a dict with the detected ``chapters``, the ``duration`` in seconds and the
    ``source`` audio path.
    """
    audio_path = resolve_audio_source(book)
    if not audio_path:
        raw_files = (book.extra_metadata or {}).get("audio_files")
        if isinstance(raw_files, list) and len(raw_files) > 1:
            raise ChapterDetectionError(
                "Multi-track audiobooks already have per-track chapters"
            )
        raise ChapterDetectionError("No audio source found for this book")

    if subtitle_candidates:
        segments = load_subtitle_segments(subtitle_candidates)
        if segments:
            chapters = detect_chapters_from_segments(segments, gap_threshold_sec)
            duration = segments[-1]["end"] if segments else 0.0
            logger.info(
                "Reusing %s stored subtitle cues for chapter detection of \"%s\" (transcription skipped)",
                len(segments),
                book.title or Path(book.file_path).stem,
            )
            return {"chapters": chapters, "duration": duration, "source": audio_path}

    result = asr_service.transcribe_full_source(
        audio_path,
        language,
        batch_size,
        chunk_length_s,
        vad_filter,
        duration_sec=book.duration,
    )
    chapters = detect_chapters_from_segments(result.segments, gap_threshold_sec)
    duration = result.segments[-1]["end"] if result.segments else 0.0
    return {"chapters": chapters, "duration": duration, "source": audio_path}


async def apply_chapters_to_book(
    db: AsyncSession,
    book: Book,
    chapters: list[dict],
    *,
    overwrite: bool,
    duration: float | None = None,
) -> None:
    result = await db.execute(
        select(Chapter).where(Chapter.book_id == book.id).order_by(Chapter.index)
    )
    existing = list(result.scalars().all())
    if existing and not overwrite:
        raise ChapterDetectionError("Book already has chapters; use overwrite to replace them")

    existing_ids = [chapter.id for chapter in existing]
    if existing_ids:
        await db.execute(
            delete(SubtitleMetadata).where(SubtitleMetadata.chapter_id.in_(existing_ids))
        )
        await db.execute(
            update(GenerationLog)
            .where(GenerationLog.chapter_id.in_(existing_ids))
            .values(chapter_id=None)
        )
        await db.execute(delete(Chapter).where(Chapter.id.in_(existing_ids)))
    await db.flush()

    for i, ch in enumerate(chapters):
        db.add(
            Chapter(
                book_id=book.id,
                index=ch.get("index", i),
                title=ch.get("title", f"Chapter {i + 1}"),
                start_position=ch.get("start_position"),
                end_position=ch.get("end_position"),
            )
        )

    if duration and (not book.duration or book.duration <= 0):
        book.duration = duration

    await db.commit()
    await db.refresh(book)
