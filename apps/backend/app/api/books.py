from __future__ import annotations

import os
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from meilisearch import Client as MeiliClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_current_user_from_request, get_db, get_meili_client
from app.models.user import User
from app.schemas.book import BookCreate, BookList, BookResponse, ChapterResponse
from app.schemas.bookmark import BookmarkCreate, BookmarkResponse
from app.schemas.progress import ReadingProgressResponse, UpdateProgress
from app.services.book_service import (
    create_bookmark,
    delete_bookmark,
    get_book,
    get_book_for_user,
    get_book_cover,
    get_bookmarks,
    get_books,
    get_progress,
    update_progress,
)

router = APIRouter()


@router.get("", response_model=BookList)
async def list_books(
    library_id: UUID | None = Query(None),
    search: str | None = Query(None),
    author: str | None = Query(None),
    series: str | None = Query(None),
    format: str | None = Query(None, alias="format"),
    sort: str = Query("title"),
    order: str = Query("asc"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    filters = {
        "library_id": library_id,
        "search": search,
        "author": author,
        "series": series,
        "format": format,
        "sort": sort,
        "order": order,
        "limit": limit,
        "offset": offset,
    }
    books, total = await get_books(db, filters, current_user.id)
    return BookList(items=books, total=total, limit=limit, offset=offset)


@router.get("/{book_id}", response_model=BookResponse)
async def get_book_detail(
    book_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    return book


@router.get("/{book_id}/cover")
async def get_cover(
    book_id: UUID,
    current_user: User = Depends(get_current_user_from_request),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    cover_path = await get_book_cover(db, book_id)
    if cover_path is None or not os.path.isfile(cover_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cover not found")
    from fastapi.responses import FileResponse
    return FileResponse(cover_path, media_type="image/jpeg")


@router.get("/{book_id}/download")
async def download_book(
    book_id: UUID,
    current_user: User = Depends(get_current_user_from_request),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    metadata = book.extra_metadata or {}
    file_path = str(metadata.get("ebook_path") or book.file_path)
    file_format = str(metadata.get("ebook_format") or book.file_format.value)
    if not os.path.isfile(file_path):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="File not found")
    from fastapi.responses import FileResponse

    media_types = {
        "epub": "application/epub+zip",
        "pdf": "application/pdf",
        "mobi": "application/x-mobipocket-ebook",
        "cbz": "application/vnd.comicbook+zip",
        "cbr": "application/vnd.comicbook-rar",
        "mp3": "audio/mpeg",
        "m4b": "audio/mp4",
        "flac": "audio/flac",
        "ogg": "audio/ogg",
        "aac": "audio/aac",
    }
    media_type = media_types.get(file_format, "application/octet-stream")
    return FileResponse(
        file_path,
        media_type=media_type,
        filename=os.path.basename(file_path),
    )


@router.post("/{book_id}/progress", response_model=ReadingProgressResponse)
async def update_reading_progress(
    book_id: UUID,
    data: UpdateProgress,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    progress = await update_progress(db, current_user.id, book_id, data.position, data.progress, data.location)
    return progress


@router.get("/{book_id}/progress", response_model=ReadingProgressResponse | None)
async def get_reading_progress(
    book_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    progress = await get_progress(db, current_user.id, book_id)
    return progress


@router.post("/{book_id}/bookmarks", response_model=BookmarkResponse, status_code=status.HTTP_201_CREATED)
async def create_bookmark_endpoint(
    book_id: UUID,
    data: BookmarkCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    bookmark = await create_bookmark(db, current_user.id, book_id, data)
    return bookmark


@router.get("/{book_id}/bookmarks", response_model=list[BookmarkResponse])
async def list_bookmarks(
    book_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    bookmarks = await get_bookmarks(db, current_user.id, book_id)
    return bookmarks


@router.delete("/{book_id}/bookmarks/{bookmark_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_bookmark(
    book_id: UUID,
    bookmark_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    bookmarks = await get_bookmarks(db, current_user.id, book_id)
    if not any(b.id == bookmark_id for b in bookmarks):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Bookmark not found")
    await delete_bookmark(db, bookmark_id)
