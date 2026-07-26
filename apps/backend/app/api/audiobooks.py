from __future__ import annotations

import os
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user_from_request, get_db
from app.models.user import User
from app.services.audiobook_service import get_or_create_hls_playlist, get_stream_segment
from app.services.audiobook_service import get_audio_files
from app.services.book_service import get_book_for_user

router = APIRouter()


@router.get("/{book_id}/download")
async def download_audiobook(
    book_id: UUID,
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

    media_types = {
        "mp3": "audio/mpeg",
        "m4b": "audio/mp4",
        "flac": "audio/flac",
        "ogg": "audio/ogg",
        "aac": "audio/aac",
        "wma": "audio/x-ms-wma",
    }
    audio_format = str((book.extra_metadata or {}).get("audiobook_format") or book.file_format.value)
    return FileResponse(
        audio_path,
        media_type=media_types.get(audio_format, "application/octet-stream"),
        filename=os.path.basename(audio_path),
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
