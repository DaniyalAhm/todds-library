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


async def get_or_create_hls_playlist(book: Book) -> str | None:
    audio_files = get_audio_files(book)
    if not audio_files and book.file_format.value not in ("mp3", "m4b", "flac", "ogg", "aac", "wma"):
        return None
    output_dir = HLS_DIR / str(book.id)
    output_dir.mkdir(parents=True, exist_ok=True)
    playlist_path = output_dir / "master.m3u8"
    if not playlist_path.is_file():
        try:
            playlist = await _transcode_for_book(book, audio_files, str(output_dir))
            return playlist
        except Exception:
            logger.exception("HLS transcode failed for %s; attempting audio repair", book.id)

        repaired = await _repair_transcode_sources(audio_files)
        if repaired is None:
            return None
        try:
            playlist = await _transcode_for_book(book, repaired, str(output_dir))
            return playlist
        except Exception:
            logger.exception("HLS transcode failed for %s even after repair", book.id)
            return None
    return str(playlist_path)


async def _transcode_for_book(book: Book, audio_files: list[str], output_dir: str) -> str:
    if len(audio_files) > 1:
        return transcode_files_to_hls(audio_files, output_dir)
    if len(audio_files) == 1:
        return transcode_file_to_hls(audio_files[0], output_dir)
    return transcode_file_to_hls(book.file_path, output_dir)


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
