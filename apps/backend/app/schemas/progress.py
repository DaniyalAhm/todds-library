from __future__ import annotations

from datetime import datetime, timezone
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class ReadingProgressResponse(BaseModel):
    id: UUID
    user_id: UUID
    book_id: UUID
    position: float
    captured_at: int | None = None
    position_updated_at: datetime | None = None
    location: str | None = None
    progress: float = Field(..., ge=0.0, le=1.0)
    rating: int | None = None
    review_text: str | None = None
    review_updated_at: datetime | None = None
    completed: bool = False
    completed_at: datetime | None = None
    last_updated: datetime

    @field_validator('last_updated', 'completed_at', 'review_updated_at', 'position_updated_at')
    @classmethod
    def utc_timestamps(cls, value):
        if value is None:
            return value
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)

    model_config = {"from_attributes": True}


class UpdateProgress(BaseModel):
    expected_user_id: UUID | None = None
    captured_at: int | None = Field(default=None, ge=0, strict=True)
    position: float = Field(default=0.0, ge=0, allow_inf_nan=False)
    location: str | None = None
    progress: float = Field(0.0, ge=0.0, le=1.0)

    @field_validator('captured_at')
    @classmethod
    def validate_capture_time(cls, value):
        if value is not None and value > int(datetime.now(timezone.utc).timestamp() * 1000) + 300000:
            raise ValueError('Progress capture time is too far in the future')
        return value


class UpdateBookReview(BaseModel):
    rating: int = Field(..., ge=1, le=5, strict=True)
    review_text: str = Field(default="", max_length=5000)


class BookRatingsResponse(BaseModel):
    average_rating: float | None = None
    rating_count: int = 0
    distribution: dict[int, int]
