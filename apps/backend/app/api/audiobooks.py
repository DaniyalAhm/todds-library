from __future__ import annotations

import asyncio
import os
import shutil
from collections.abc import AsyncIterator
from pathlib import Path
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user_from_request, get_db
from app.models.user import User
from app.services.audiobook_service import get_or_create_hls_playlist, get_stream_segment
from app.services.audiobook_service import get_audio_files
from app.services.book_service import get_book_for_user

router = APIRouter()

_REPAIR_PATH_CACHE: dict[tuple, str | None] = {}
_AUDIO_CHUNK_SIZE = 1024 * 1024


def _audio_media_type(audio_format: str) -> str:
    media_types = {
        "mp3": "audio/mpeg",
        "m4b": "audio/mp4",
        "m4a": "audio/mp4",
        "flac": "audio/flac",
        "ogg": "audio/ogg",
        "opus": "audio/ogg",
        "aac": "audio/aac",
        "wma": "audio/x-ms-wma",
    }
    return media_types.get(audio_format.lower(), "application/octet-stream")


def _range_headers(content_length: int, media_type: str, content_range: str | None = None) -> dict[str, str]:
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
        "Content-Length": str(content_length),
        "X-Content-Type-Options": "nosniff",
    }
    if content_range is not None:
        headers["Content-Range"] = content_range
    return headers


def _parse_range(range_header: str | None, file_size: int) -> tuple[int, int] | None:
    if not range_header:
        return None
    unit, separator, range_value = range_header.strip().partition("=")
    if separator != "=" or unit.lower() != "bytes":
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{file_size}"},
        )
    # Mobile browsers issue single ranges for media playback. Multiple ranges
    # are intentionally rejected instead of generating multipart responses.
    if "," in range_value:
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    start_text, separator, end_text = range_value.partition("-")
    if separator != "-":
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{file_size}"},
        )

    try:
        if start_text == "":
            suffix_length = int(end_text)
            if suffix_length <= 0:
                raise ValueError
            start = max(0, file_size - suffix_length)
            end = file_size - 1
        else:
            start = int(start_text)
            end = int(end_text) if end_text else file_size - 1
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{file_size}"},
        ) from None

    if start < 0 or end < start or start >= file_size:
        raise HTTPException(
            status_code=status.HTTP_416_RANGE_NOT_SATISFIABLE,
            headers={"Content-Range": f"bytes */{file_size}"},
        )
    return start, min(end, file_size - 1)


async def _iter_file_range(path: str, start: int, end: int) -> AsyncIterator[bytes]:
    with open(path, "rb") as file:
        file.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = file.read(min(_AUDIO_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
            await asyncio.sleep(0)


def _stream_audio_file(path: str, media_type: str, range_header: str | None) -> Response:
    file_size = os.path.getsize(path)
    byte_range = _parse_range(range_header, file_size)
    if byte_range is None:
        start, end = 0, file_size - 1
        return StreamingResponse(
            _iter_file_range(path, start, end),
            media_type=media_type,
            headers=_range_headers(file_size, media_type),
        )

    start, end = byte_range
    content_length = end - start + 1
    return StreamingResponse(
        _iter_file_range(path, start, end),
        status_code=status.HTTP_206_PARTIAL_CONTENT,
        media_type=media_type,
        headers=_range_headers(content_length, media_type, f"bytes {start}-{end}/{file_size}"),
    )


IPAD_INCOMPATIBLE_FORMATS = {"wma", "ogg", "opus", "flac"}


def _sanitized_download_path(audio_path: str, force_transcode: bool = False) -> str | None:
    """Return a clean playback path for a corrupt/degraded source.

    Healthy files are served directly; damaged files are transparently
    re-encoded into a cached repair copy (never touching the source).
    When ``force_transcode`` is True (e.g. wma/ogg/flac that iPad cannot
    decode natively) a repair is attempted even for ``ok`` health.
    """
    if not shutil.which("ffmpeg"):
        return None

    from app.services.audio_health_service import check_audio_file, resolve_repair_path

    result = check_audio_file(audio_path, full_decode=False)
    if not force_transcode and (result.status == "ok" or result.status == "unreadable"):
        return None
    return resolve_repair_path(audio_path)


async def _cached_sanitized_download_path(audio_path: str, force_transcode: bool = False) -> str | None:
    try:
        stat = os.stat(audio_path)
    except OSError:
        return None
    cache_key = (audio_path, stat.st_mtime_ns, stat.st_size, force_transcode)
    if cache_key not in _REPAIR_PATH_CACHE:
        _REPAIR_PATH_CACHE[cache_key] = _sanitized_download_path(audio_path, force_transcode=force_transcode)
    return _REPAIR_PATH_CACHE[cache_key]


def _audio_needs_repair(extra_metadata: dict | None) -> bool:
    audio_health = (extra_metadata or {}).get("audio_health")
    if not isinstance(audio_health, dict):
        return False
    return audio_health.get("status") in {"degraded", "corrupt"}


@router.get("/{book_id}/download")
async def download_audiobook(
    book_id: UUID,
    request: Request,
    track: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user_from_request),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    audio_files = get_audio_files(book)
    if audio_files and track >= len(audio_files):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio track not found")
    audio_path = audio_files[track] if audio_files else (
        book.file_path if book.file_format.value in {"mp3", "m4b", "flac", "ogg", "aac", "wma"} else None
    )
    if not audio_path or not os.path.isfile(audio_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Audio file not found")

    extra_metadata = book.extra_metadata or {}
    audio_format = (
        Path(audio_path).suffix.lstrip(".")
        or str(extra_metadata.get("audiobook_format") or book.file_format.value)
    )

    # iPad Safari cannot decode wma/ogg/opus/flac natively. For those
    # formats, transparently serve a repaired mp3 (audio/mpeg) so direct
    # fallback playback works even when the file is technically "ok".
    needs_repair = _audio_needs_repair(extra_metadata)
    force_ipad_transcode = audio_format.lower() in IPAD_INCOMPATIBLE_FORMATS
    sanitized_path = None
    if needs_repair or force_ipad_transcode:
        sanitized_path = await _cached_sanitized_download_path(audio_path, force_transcode=force_ipad_transcode)
    if sanitized_path is not None:
        return _stream_audio_file(
            sanitized_path,
            media_type="audio/mpeg",
            range_header=request.headers.get("range"),
        )

    return _stream_audio_file(
        audio_path,
        media_type=_audio_media_type(audio_format),
        range_header=request.headers.get("range"),
    )


@router.get("/{book_id}/stream")
async def stream_hls_playlist(
    book_id: UUID,
    request: Request,
    current_user: User = Depends(get_current_user_from_request),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    playlist_path = await get_or_create_hls_playlist(book)
    if playlist_path is None or not os.path.isfile(playlist_path):
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate HLS playlist",
        )
    with open(playlist_path, "r") as playlist_file:
        content = playlist_file.read()
    access_token = request.query_params.get("access_token")
    segment_query = (
        f"?access_token={quote(access_token, safe='')}" if access_token else ""
    )
    lines = []
    for line in content.splitlines():
        if line and not line.startswith("#"):
            lines.append(f"stream/{line}{segment_query}")
        else:
            lines.append(line)
    from fastapi.responses import Response
    return Response(content="\n".join(lines) + "\n", media_type="application/vnd.apple.mpegurl")


@router.get("/{book_id}/stream/{segment}")
async def stream_segment(
    book_id: UUID,
    segment: str,
    current_user: User = Depends(get_current_user_from_request),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    data = await get_stream_segment(book, segment)
    if data is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Segment not found")
    from fastapi.responses import Response
    return Response(content=data, media_type="video/MP2T")


@router.get("/{book_id}/cover")
async def get_audiobook_cover(
    book_id: UUID,
    current_user: User = Depends(get_current_user_from_request),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    if book.cover_path and os.path.isfile(book.cover_path):
        return FileResponse(book.cover_path, media_type="image/jpeg")
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cover not found")
