from __future__ import annotations

from fastapi import APIRouter

from app.api import asr, auth, audiobooks, books, generate, libraries, metadata, search, settings

router = APIRouter()

router.include_router(auth.router, prefix="/auth", tags=["auth"])
router.include_router(libraries.router, prefix="/libraries", tags=["libraries"])
router.include_router(books.router, prefix="/books", tags=["books"])
router.include_router(audiobooks.router, prefix="/audiobooks", tags=["audiobooks"])
router.include_router(search.router, prefix="/search", tags=["search"])
router.include_router(metadata.router, prefix="/metadata", tags=["metadata"])
router.include_router(settings.router, prefix="", tags=["settings"])
router.include_router(asr.router, prefix="", tags=["asr"])
router.include_router(generate.router, prefix="", tags=["generate"])
