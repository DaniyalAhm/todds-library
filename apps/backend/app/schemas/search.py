from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel


class SearchResult(BaseModel):
    id: UUID
    title: str
    author: str | None = None
    series: str | None = None
    description: str | None = None
    file_format: str
    library_id: UUID
    cover_path: str | None = None
    match_score: float | None = None


class SearchResponse(BaseModel):
    results: list[SearchResult]
    total: int
    query: str
    type_filter: str
    limit: int
    offset: int
    used_fallback: bool = False
