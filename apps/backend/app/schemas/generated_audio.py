from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel


class GenerateAudioRequest(BaseModel):
    voice_id: str
    chapter_indices: list[int] | None = None


class GenerateAudioResponse(BaseModel):
    id: uuid.UUID
    book_id: uuid.UUID
    user_id: uuid.UUID
    chapter_index: int
    voice_id: str
    file_path: str
    duration: float | None = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}
