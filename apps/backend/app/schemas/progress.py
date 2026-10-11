from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel, Field


class ReadingProgressResponse(BaseModel):
    id: UUID
    user_id: UUID
    book_id: UUID
    position: float
    location: str | None = None
    progress: float = Field(..., ge=0.0, le=1.0)
    rating: int | None = None
    review_text: str | None = None
    review_updated_at: datetime | None = None
    completed: bool = False
    completed_at: datetime | None = None
    last_updated: datetime

    model_config = {"from_attributes": True}


class UpdateProgress(BaseModel):
    position: float = 0.0
    location: str | None = None
    progress: float = Field(0.0, ge=0.0, le=1.0)


class UpdateBookReview(BaseModel):
    rating: int = Field(..., ge=1, le=5, strict=True)
    review_text: str = Field(default="", max_length=5000)


class BookRatingsResponse(BaseModel):
    average_rating: float | None = None
    rating_count: int = 0
    distribution: dict[int, int]
