from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from meilisearch import Client as MeiliClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_meili_client
from app.models.user import User
from app.schemas.search import SearchResponse, SearchResult
from app.services.library_service import get_libraries
from app.services.search_service import fallback_search, search_books

router = APIRouter()


@router.get("", response_model=SearchResponse)
async def search(
    q: str = Query("", min_length=1),
    type: str = Query("all", alias="type"),
    limit: int = Query(20, ge=1, le=200),
    offset: int = Query(0, ge=0),
    meili: MeiliClient = Depends(get_meili_client),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    used_fallback = False
    libraries = await get_libraries(db, current_user)
    library_ids = [library.id for library in libraries]
    try:
        results = await search_books(meili, q, library_ids, type, limit, offset)
    except Exception:
        results = await fallback_search(db, q, current_user.id, type, limit, offset)
        used_fallback = True

    search_results = []
    for r in results:
        search_results.append(
            SearchResult(
                id=r.get("id") if isinstance(r, dict) else r.id,
                title=r.get("title") if isinstance(r, dict) else r.title,
                author=r.get("author") if isinstance(r, dict) else r.author,
                series=r.get("series") if isinstance(r, dict) else r.series,
                description=r.get("description") if isinstance(r, dict) else r.description,
                file_format=r.get("file_format") if isinstance(r, dict) else r.file_format.value,
                library_id=r.get("library_id") if isinstance(r, dict) else r.library_id,
                cover_path=r.get("cover_path") if isinstance(r, dict) else r.cover_path,
                match_score=r.get("_score", 0) if isinstance(r, dict) else None,
            )
        )

    return SearchResponse(
        results=search_results,
        total=len(search_results),
        query=q,
        type_filter=type,
        limit=limit,
        offset=offset,
        used_fallback=used_fallback,
    )
