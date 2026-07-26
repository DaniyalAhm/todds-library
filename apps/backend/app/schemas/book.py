from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class ChapterResponse(BaseModel):
    id: UUID
    index: int
    title: str
    start_position: float | None = None

    model_config = {"from_attributes": True}


class BookBase(BaseModel):
    title: str
    author: str | None = None
    series: str | None = None
    series_index: float | None = None
    isbn: str | None = None
    asin: str | None = None
    description: str | None = None
    publisher: str | None = None
    published_date: str | None = None
    language: str | None = None
    page_count: int | None = None
    duration: float | None = None


class BookCreate(BookBase):
    library_id: UUID
    file_path: str
    file_format: str = "unknown"
    file_size: int = 0
    cover_path: str | None = None
    file_hash: str | None = None


class BookResponse(BookBase):
    id: UUID
    library_id: UUID
    file_path: str
    file_format: str
    file_size: int
    cover_path: str | None = None
    file_hash: str | None = None
    has_ebook: bool = False
    has_audiobook: bool = False
    ebook_format: str | None = None
    audiobook_format: str | None = None
    audio_track_count: int = 0
    progress: float = Field(0.0, ge=0.0, le=1.0)
    chapters: list[ChapterResponse] = []
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class BookUpdate(BaseModel):
    title: str | None = None
    author: str | None = None
    series: str | None = None
    series_index: float | None = None
    isbn: str | None = None
    asin: str | None = None
    description: str | None = None
    publisher: str | None = None
    published_date: str | None = None
    language: str | None = None
    page_count: int | None = None
    duration: float | None = None


class BookList(BaseModel):
    items: list[BookResponse]
    total: int
    limit: int
    offset: int
