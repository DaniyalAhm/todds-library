from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel


class BookmarkBase(BaseModel):
    position: float
    location: str | None = None
    note: str | None = None


class BookmarkCreate(BookmarkBase):
    pass


class BookmarkResponse(BookmarkBase):
    id: UUID
    user_id: UUID
    book_id: UUID
    created_at: datetime

    model_config = {"from_attributes": True}
