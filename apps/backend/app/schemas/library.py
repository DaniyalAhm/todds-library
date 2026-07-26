from __future__ import annotations

from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from app.models.library import LibraryType


class LibraryBase(BaseModel):
    name: str
    path: str
    type: LibraryType = LibraryType.mixed


class LibraryCreate(LibraryBase):
    pass


class DirectoryEntry(BaseModel):
    name: str
    path: str
    has_children: bool = False


class DirectoryList(BaseModel):
    root: str
    current: str
    parent: str | None = None
    items: list[DirectoryEntry]


class LibraryResponse(LibraryBase):
    id: UUID
    user_id: UUID
    book_count: int = 0
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class LibraryList(BaseModel):
    items: list[LibraryResponse]
