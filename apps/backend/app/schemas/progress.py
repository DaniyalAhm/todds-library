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
    last_updated: datetime

    model_config = {"from_attributes": True}


class UpdateProgress(BaseModel):
    position: float = 0.0
    location: str | None = None
    progress: float = Field(0.0, ge=0.0, le=1.0)
