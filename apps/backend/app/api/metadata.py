from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from meilisearch import Client as MeiliClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_db, get_meili_client, require_admin
from app.models.user import User
from app.schemas.book import BookResponse, BookUpdate
from app.services.book_service import get_book_for_user
from app.services.library_service import get_library
from app.services.metadata_service import apply_metadata_to_book, enrich_book_metadata, lookup_metadata
from app.services.search_service import index_book_in_meili

router = APIRouter()


@router.post("/refresh/{book_id}", response_model=BookResponse)
async def refresh_book_metadata(
    book_id: UUID,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    meili: MeiliClient = Depends(get_meili_client),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    book = await enrich_book_metadata(db, book)
    try:
        index_book_in_meili(meili, book)
    except Exception:
        pass
    return book


@router.post("/refresh/library/{library_id}")
async def refresh_library_metadata(
    library_id: UUID,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    meili: MeiliClient = Depends(get_meili_client),
):
    library = await get_library(db, library_id, current_user)
    if library is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Library not found")
    from app.models.book import Book
    from sqlalchemy import select
    result = await db.execute(select(Book).where(Book.library_id == library_id))
    books = result.scalars().all()
    enriched_count = 0
    for book in books:
        try:
            enriched = await enrich_book_metadata(db, book)
            try:
                index_book_in_meili(meili, enriched)
            except Exception:
                pass
            enriched_count += 1
        except Exception:
            continue
    return {"message": f"Refreshed metadata for {enriched_count}/{len(books)} books"}


@router.get("/lookup/{book_id}")
async def lookup_book_metadata(
    book_id: UUID,
    title: str | None = Query(None),
    author: str | None = Query(None),
    isbn: str | None = Query(None),
    asin: str | None = Query(None),
    refresh: bool = Query(False),
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    results = await lookup_metadata(
        db,
        book_id=book.id,
        isbn=isbn or book.isbn,
        asin=asin or book.asin,
        title=title or book.title,
        author=author or book.author,
        force_refresh=refresh,
    )
    return {"results": results}


@router.post("/apply/{book_id}", response_model=BookResponse)
async def apply_book_metadata(
    book_id: UUID,
    data: dict = Body(...),
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    meili: MeiliClient = Depends(get_meili_client),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    book = await apply_metadata_to_book(db, book, data, overwrite=True)
    try:
        index_book_in_meili(meili, book)
    except Exception:
        pass
    return book


@router.put("/{book_id}", response_model=BookResponse)
async def update_book_metadata(
    book_id: UUID,
    data: BookUpdate,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
    meili: MeiliClient = Depends(get_meili_client),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(book, key, value)
    await db.commit()
    await db.refresh(book)
    try:
        index_book_in_meili(meili, book)
    except Exception:
        pass
    return book
