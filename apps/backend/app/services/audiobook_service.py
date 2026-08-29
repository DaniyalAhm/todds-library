from __future__ import annotations

import asyncio
import logging
import os
import shutil
from pathlib import Path

from app.config import settings
from app.models.book import Book
from app.services.audio_health_service import resolve_repair_path
from app.transcoder.hls import (
    cleanup_segments,
    get_segment,
    transcode_files_to_hls,
    transcode_to_hls as transcode_file_to_hls,
)

logger = logging.getLogger(__name__)
HLS_DIR = Path(settings.covers_dir).parent / "hls"

# Serialize transcodes per book so concurrent stream requests to the same book
# do not collide while writing segments into the same output directory.
_HLS_LOCKS: dict[str, asyncio.Lock] = {}


def _hls_lock(book_id: str) -> asyncio.Lock:
    lock = _HLS_LOCKS.get(book_id)
    if lock is None:
        lock = asyncio.Lock()
        _HLS_LOCKS[book_id] = lock
    return lock


def _playlist_is_valid(playlist_path: Path) -> bool:
    if not playlist_path.is_file():
        return False
    try:
        if playlist_path.stat().st_size == 0:
            return False
        content = playlist_path.read_text()
        # Valid VOD playlist must contain at least one segment reference
        return "segment_" in content
    except OSError:
        return False


def _playlist_is_stale(playlist_path: Path, audio_files: list[str]) -> bool:
    """Return True if any source file is newer than the playlist."""
    try:
        playlist_mtime = playlist_path.stat().st_mtime
    except OSError:
        return True
    for src in audio_files:
        try:
            if os.path.getmtime(src) > playlist_mtime:
                return True
        except OSError:
            continue
    return False


async def get_or_create_hls_playlist(book: Book) -> str | None:
    audio_files = get_audio_files(book)
    meta = book.extra_metadata or {}
    declared_audio_files = meta.get("audio_files")
    # If book declares multi-track but none of the files exist on disk, fail
    # fast instead of falling back to a non-audio file_path (e.g. epub).
    if isinstance(declared_audio_files, list) and len(declared_audio_files) > 0 and not audio_files:
        logger.warning("[bold cyan][HLS][/] requested for %s but no declared audio files exist on disk", book.id)
        return None
    if not audio_files and book.file_format.value not in ("mp3", "m4b", "flac", "ogg", "aac", "wma"):
        return None
    # Fallback for single-file books where file_path is the audio source
    if not audio_files and book.file_path and os.path.isfile(book.file_path):
        audio_files = [book.file_path]
    output_dir = HLS_DIR / str(book.id)
    output_dir.mkdir(parents=True, exist_ok=True)
    playlist_path = output_dir / "master.m3u8"
    logger.info("[bold cyan][HLS][/] request book=%s title='%s' files=%s", book.id, book.title, len(audio_files))
    # Invalidate stale playlist when source files changed since generation
    if _playlist_is_valid(playlist_path) and _playlist_is_stale(playlist_path, audio_files):
        try:
            playlist_path.unlink(missing_ok=True)
        except OSError:
            pass
    if _playlist_is_valid(playlist_path):
        logger.info("[green][HLS][/] cache hit book=%s", book.id)
        return str(playlist_path)
    # Remove stale/empty playlist so transcode can recreate it
    if playlist_path.is_file() and not _playlist_is_valid(playlist_path):
        logger.warning("[bold yellow][HLS][/] invalid playlist book=%s -> removing", book.id)
        try:
            playlist_path.unlink(missing_ok=True)
        except OSError:
            pass

    async with _hls_lock(str(book.id)):
        if _playlist_is_valid(playlist_path) and not _playlist_is_stale(playlist_path, audio_files):
            logger.info("[green][HLS][/] cache hit (locked) book=%s", book.id)
            return str(playlist_path)
        if playlist_path.is_file() and (not _playlist_is_valid(playlist_path) or _playlist_is_stale(playlist_path, audio_files)):
            try:
                playlist_path.unlink(missing_ok=True)
            except OSError:
                pass
        try:
            logger.info("[bold cyan][HLS][/] transcoding book=%s files=%s", book.id, len(audio_files))
            result = await _transcode_for_book(book, audio_files, str(output_dir))
            logger.info("[green][HLS][/] transcode success book=%s -> %s", book.id, result)
            return result
        except Exception:
            logger.exception("[bold red][HLS][/] transcode failed for %s; attempting repair", book.id)

        # Repair: handle both multi-track and single-file sources
        sources_for_repair = audio_files if audio_files else ([book.file_path] if book.file_path else [])
        repaired = await _repair_transcode_sources(sources_for_repair)
        if repaired is None:
            return None
        try:
            logger.info("[bold cyan][HLS][/] retry transcode after repair book=%s", book.id)
            result = await _transcode_for_book(book, repaired, str(output_dir))
            logger.info("[green][HLS][/] retry success book=%s", book.id)
            return result
        except Exception:
            logger.exception("[bold red][HLS][/] transcode failed even after repair book=%s", book.id)
            return None


async def _transcode_for_book(book: Book, audio_files: list[str], output_dir: str) -> str:
    # ffmpeg can run for a very long time; run it off the event loop so a
    # transcode never freezes the worker for every other connection.
    if len(audio_files) > 1:
        return await asyncio.to_thread(transcode_files_to_hls, audio_files, output_dir)
    if len(audio_files) == 1:
        return await asyncio.to_thread(transcode_file_to_hls, audio_files[0], output_dir)
    return await asyncio.to_thread(transcode_file_to_hls, book.file_path, output_dir)


async def _repair_transcode_sources(audio_files: list[str]) -> list[str] | None:
    repaired = []
    for path in audio_files:
        clean = await asyncio.to_thread(resolve_repair_path, path)
        if clean is None:
            logger.warning("No usable playback path for %s; skipping HLS repair", path)
            return None
        repaired.append(clean)
    return repaired


async def rebuild_hls_playlist(book: Book) -> str | None:
    """Regenerate the HLS playlist from scratch, repairing corrupt sources as needed."""
    output_dir = HLS_DIR / str(book.id)
    if output_dir.is_dir():
        shutil.rmtree(output_dir, ignore_errors=True)
    return await get_or_create_hls_playlist(book)


def get_audio_files(book: Book) -> list[str]:
    metadata = book.extra_metadata or {}
    files = metadata.get("audio_files")
    if not isinstance(files, list):
        audio_path = metadata.get("audiobook_path")
        files = [audio_path] if isinstance(audio_path, str) else []
    return [str(path) for path in files if isinstance(path, str) and os.path.isfile(path)]


async def get_stream_segment(book: Book, segment_name: str) -> bytes | None:
    output_dir = HLS_DIR / str(book.id)
    return get_segment(str(output_dir), segment_name)


async def cleanup_old_segments(book: Book) -> None:
    output_dir = HLS_DIR / str(book.id)
    cleanup_segments(str(output_dir))
