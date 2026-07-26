from __future__ import annotations

import os
from pathlib import Path

from app.config import settings
from app.models.book import Book
from app.transcoder.hls import (
    cleanup_segments,
    get_segment,
    transcode_files_to_hls,
    transcode_to_hls as transcode_file_to_hls,
)

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
            if len(audio_files) > 1:
                playlist = await transcode_audio_files_to_hls(audio_files, str(output_dir))
            elif len(audio_files) == 1:
                playlist = await transcode_to_hls(audio_files[0], str(output_dir))
            else:
                playlist = await transcode_to_hls(book.file_path, str(output_dir))
            return playlist
        except Exception:
            return None
    return str(playlist_path)


def get_audio_files(book: Book) -> list[str]:
    metadata = book.extra_metadata or {}
    files = metadata.get("audio_files")
    if not isinstance(files, list):
        audio_path = metadata.get("audiobook_path")
        files = [audio_path] if isinstance(audio_path, str) else []
    return [str(path) for path in files if isinstance(path, str) and os.path.isfile(path)]


async def transcode_to_hls(input_path: str, output_dir: str) -> str:
    playlist = transcode_file_to_hls(input_path, output_dir)
    return playlist


async def transcode_audio_files_to_hls(input_paths: list[str], output_dir: str) -> str:
    playlist = transcode_files_to_hls(input_paths, output_dir)
    return playlist


async def get_stream_segment(book: Book, segment_name: str) -> bytes | None:
    output_dir = HLS_DIR / str(book.id)
    return get_segment(str(output_dir), segment_name)


async def cleanup_old_segments(book: Book) -> None:
    output_dir = HLS_DIR / str(book.id)
    cleanup_segments(str(output_dir))
