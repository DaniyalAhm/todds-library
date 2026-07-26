from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from meilisearch import Client as MeiliClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db, get_meili_client, require_admin
from app.models.user import User
from app.schemas.library import DirectoryList, LibraryCreate, LibraryList, LibraryResponse
from app.services.library_service import (
    create_library,
    delete_library,
    get_libraries,
    get_library,
    list_library_directories,
)
from app.services.scanner_service import scan_library

router = APIRouter()


@router.get("", response_model=LibraryList)
async def list_libraries(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    libraries = await get_libraries(db, current_user)
    return LibraryList(items=libraries)


@router.get("/directories", response_model=DirectoryList)
async def list_available_directories(
    path: str | None = None,
    _admin: User = Depends(require_admin),
):
    try:
        return DirectoryList(**list_library_directories(path))
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc


@router.post("", response_model=LibraryResponse, status_code=status.HTTP_201_CREATED)
async def create_new_library(
    data: LibraryCreate,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    meili: MeiliClient = Depends(get_meili_client),
):
    try:
        library = await create_library(db, current_user, data)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc),
        ) from exc
    await scan_library(db, meili, library.id)
    return library


@router.get("/{library_id}", response_model=LibraryResponse)
async def get_library_detail(
    library_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    library = await get_library(db, library_id, current_user)
    if library is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")
    return library


@router.delete("/{library_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_library(
    library_id: UUID,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    library = await get_library(db, library_id, current_user)
    if library is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")
    await delete_library(db, library_id, current_user)


@router.post("/{library_id}/scan")
async def scan_library_endpoint(
    library_id: UUID,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    meili: MeiliClient = Depends(get_meili_client),
):
    library = await get_library(db, library_id, current_user)
    if library is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")
    result = await scan_library(db, meili, library_id)
    return {
        "task_id": str(library_id),
        "status": "completed",
        "new_books": result.get("new", 0),
        "updated_books": result.get("updated", 0),
        "removed_books": result.get("removed", 0),
    }
