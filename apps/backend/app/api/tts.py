from __future__ import annotations

import asyncio
import os
import logging
from pathlib import Path
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_current_user, get_current_user_from_request, get_db, require_admin
from app.models.book import Book
from app.models.chapter import Chapter
from app.models.generated_audio import GeneratedAudio
from app.models.generation_log import GenerationLog
from app.models.user import User
from app.services.book_service import get_book_for_user
from app.services import castwright_service
from app.services.castwright_service import CastwrightError

logger = logging.getLogger(__name__)

router = APIRouter()


def _ebook_path(book: Book) -> str | None:
    meta = book.extra_metadata or {}
    p = meta.get("ebook_path") or (book.file_path if book.file_format.value == "epub" else None)
    if p and os.path.isfile(p):
        return p
    if book.file_path and os.path.isfile(book.file_path) and book.file_path.lower().endswith(".epub"):
        return book.file_path
    return None


def _generated_dir(book: Book) -> Path:
    """Per-book folder for generated audio — inside the book's own folder so scanner/file-management sees it."""
    # Use BOOKS_DIR-relative logic: book.file_path parent is the book folder
    base = Path(book.file_path).parent
    # if custom override set, use it/book_id
    if settings.generated_audio_dir:
        return Path(settings.generated_audio_dir) / str(book.id)
    # default: alongside ebook, scanner-visible
    return base / "generated_audio"


class GenerateChapterRequest(BaseModel):
    ollama_model: str | None = None
    tts_model_key: str | None = None
    overwrite: bool = False


async def _add_log(db: AsyncSession, book_id, chapter_id, chapter_index, book_title: str, status_val: str, msg: str):
    db.add(GenerationLog(book_id=book_id, chapter_id=chapter_id, chapter_index=chapter_index, book_title=book_title, status=status_val, message=msg))
    await db.commit()


@router.get("/castwright/health")
async def castwright_health(current_user: User = Depends(require_admin)):
    if not castwright_service.is_castwright_enabled():
        return {"enabled": False}
    data = await castwright_service.check_health()
    return data


@router.get("/castwright/models")
async def castwright_models(current_user: User = Depends(require_admin)):
    if not castwright_service.is_castwright_enabled():
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Castwright disabled")
    try:
        models = await castwright_service.list_ollama_models()
        return {"models": models, "ollama_url": castwright_service.ollama_base()}
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(e))


@router.get("/books/{book_id}/chapters/{chapter_id}/generate/audio/status")
async def get_chapter_tts_status(
    book_id: UUID,
    chapter_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    ch = (await db.execute(select(Chapter).where(Chapter.id == chapter_id, Chapter.book_id == book_id))).scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="Chapter not found")
    rows = (await db.execute(select(GeneratedAudio).where(GeneratedAudio.book_id == book_id, GeneratedAudio.chapter_id == chapter_id))).scalars().all()
    # also from generation logs
    logs = (await db.execute(select(GenerationLog).where(GenerationLog.book_id == book_id, GenerationLog.chapter_id == chapter_id).order_by(GenerationLog.created_at.desc()).limit(20))).scalars().all()
    # file exists?
    gdir = _generated_dir(book)
    files = list(gdir.glob(f"chapter_{ch.index:04d}.*")) if gdir.exists() else []
    locked = castwright_service.tts_lock_locked()
    return {
        "book_id": str(book_id),
        "chapter_id": str(chapter_id),
        "chapter_index": ch.index,
        "locked": locked,
        "generated": [{"id": str(r.id), "status": r.status, "file_path": r.file_path, "ollama_model": r.ollama_model, "tts_model_key": r.tts_model_key, "created_at": r.created_at.isoformat()} for r in rows],
        "files": [str(p) for p in files],
        "logs": [{"status": lg.status, "message": lg.message, "created_at": lg.created_at.isoformat()} for lg in logs],
    }


@router.get("/books/{book_id}/generate/audio/status")
async def get_book_tts_status(
    book_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    rows = (await db.execute(select(GeneratedAudio).where(GeneratedAudio.book_id == book_id).order_by(GeneratedAudio.chapter_index))).scalars().all()
    return {
        "book_id": str(book_id),
        "locked": castwright_service.tts_lock_locked(),
        "generated": [{"chapter_index": r.chapter_index, "chapter_id": str(r.chapter_id) if r.chapter_id else None, "status": r.status, "file_path": r.file_path, "created_at": r.created_at.isoformat()} for r in rows],
    }


@router.post("/books/{book_id}/chapters/{chapter_id}/generate/audio")
async def generate_chapter_audio(
    book_id: UUID,
    chapter_id: UUID,
    req: GenerateChapterRequest | None = None,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    if not castwright_service.is_castwright_enabled():
        raise HTTPException(status_code=503, detail="Castwright disabled — set CASTWRIGHT_ENABLED=true and CASTWRIGHT_URL=http://host.docker.internal:9990")
    if castwright_service.tts_lock_locked():
        raise HTTPException(status_code=409, detail="Another chapter is already generating — only one at a time is allowed. Wait or cancel the current job.")

    book = await get_book_for_user(db, book_id, current_user.id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    epub_path = _ebook_path(book)
    if not epub_path:
        raise HTTPException(status_code=400, detail="Book has no EPUB file — only EPUB books can be generated via Castwright")
    ch = (await db.execute(select(Chapter).where(Chapter.id == chapter_id, Chapter.book_id == book_id))).scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="Chapter not found")

    overwrite = bool(req and req.overwrite)
    ollama_model = req.ollama_model if req else None
    tts_model_key = req.tts_model_key if req else None

    # check existing
    existing = (await db.execute(select(GeneratedAudio).where(GeneratedAudio.book_id == book_id, GeneratedAudio.chapter_id == chapter_id))).scalar_one_or_none()
    if existing and not overwrite:
        raise HTTPException(status_code=409, detail="Generated audio already exists for this chapter. Use overwrite=true to regenerate.")

    # also check file on disk
    gdir = _generated_dir(book)
    existing_file = gdir / f"chapter_{ch.index:04d}.mp3"
    if existing_file.exists() and not overwrite:
        raise HTTPException(status_code=409, detail="Audio file already exists on disk. Use overwrite=true to regenerate.")

    book_title = book.title or Path(book.file_path).stem
    await _add_log(db, book.id, ch.id, ch.index, book_title, "started", f"Starting full-cast generation chapter {ch.index}: {ch.title} (ollama_model={ollama_model or 'default'})")

    # Upsert generated_audio row as processing
    if existing:
        existing.status = "processing"
        existing.ollama_model = ollama_model
        existing.tts_model_key = tts_model_key
        await db.commit()
        await db.refresh(existing)
        ga = existing
    else:
        # placeholder file_path until downloaded
        placeholder = str(gdir / f"chapter_{ch.index:04d}.mp3")
        ga = GeneratedAudio(
            book_id=book.id,
            user_id=current_user.id,
            chapter_index=ch.index,
            chapter_id=ch.id,
            voice_id="full-cast",
            file_path=placeholder,
            status="processing",
            ollama_model=ollama_model,
            tts_model_key=tts_model_key,
        )
        db.add(ga)
        await db.commit()
        await db.refresh(ga)

    # Resolve castwright book id: check extra_metadata
    meta = book.extra_metadata or {}
    cw_book_id = meta.get("castwright_book_id")
    manuscript_id = meta.get("castwright_manuscript_id")
    # If not mapped, import now
    if not cw_book_id or not manuscript_id:
        try:
            await _add_log(db, book.id, ch.id, ch.index, book_title, "progress", "Importing EPUB into Castwright (full-cast)...")
            imp = await castwright_service.import_via_castwright(epub_path)
            # imp has tempId, candidate
            temp_id = imp.get("tempId") or imp.get("temp_id")
            candidate = imp.get("candidate") or {}
            if not temp_id:
                raise CastwrightError(f"Import response missing tempId: {imp}")
            # language fallback
            lang = book.language or candidate.get("language")
            confirm = await castwright_service.confirm_castwright_book(temp_id, book.author or "Unknown", book.title, book.series, language=lang)
            cw_book_id = confirm.get("bookId") or confirm.get("book_id")
            manuscript_id = confirm.get("manuscriptId") or confirm.get("manuscript_id")
            if not cw_book_id or not manuscript_id:
                raise CastwrightError(f"Confirm response missing ids: {confirm}")
            # persist mapping
            # reload book to mutate metadata
            fresh = await db.get(Book, book.id)
            new_meta = dict(fresh.extra_metadata or {})
            new_meta["castwright_book_id"] = cw_book_id
            new_meta["castwright_manuscript_id"] = manuscript_id
            fresh.extra_metadata = new_meta
            await db.commit()
            await _add_log(db, book.id, ch.id, ch.index, book_title, "progress", f"Imported as Castwright book {cw_book_id}, manuscript {manuscript_id}")
        except Exception as e:
            logger.exception("Castwright import failed for %s", book_title)
            ga.status = "failed"
            await db.commit()
            await _add_log(db, book.id, ch.id, ch.index, book_title, "failed", f"Import failed: {e}")
            raise HTTPException(status_code=502, detail=f"Castwright import failed: {e}")

    # Ensure analysis (full-cast) — idempotent if already analysed
    try:
        await _add_log(db, book.id, ch.id, ch.index, book_title, "progress", f"Ensuring full-cast analysis (ollama_model={ollama_model or 'default'})...")
        await castwright_service.trigger_analysis(manuscript_id, ollama_model=ollama_model)
        await _add_log(db, book.id, ch.id, ch.index, book_title, "progress", "Analysis complete, starting TTS...")
    except Exception as e:
        logger.exception("Analysis failed for %s ch %s", book_title, ch.index)
        ga.status = "failed"
        await db.commit()
        await _add_log(db, book.id, ch.id, ch.index, book_title, "failed", f"Analysis failed: {e}")
        raise HTTPException(status_code=502, detail=f"Castwright analysis failed: {e}")

    # Generate single chapter (holds global lock)
    try:
        result = await castwright_service.generate_chapter(cw_book_id, ch.index, ollama_model=ollama_model, tts_model_key=tts_model_key)
        # check for failure events
        failed = [ev for ev in result.get("events", []) if ev.get("type") == "chapter_failed"]
        if failed:
            raise CastwrightError(f"Castwright generation failed: {failed[0]}")
        await _add_log(db, book.id, ch.id, ch.index, book_title, "progress", f"TTS completed for chapter {ch.index}, downloading audio...")
    except CastwrightError as e:
        ga.status = "failed"
        await db.commit()
        await _add_log(db, book.id, ch.id, ch.index, book_title, "failed", str(e))
        raise HTTPException(status_code=502, detail=str(e))
    except HTTPException:
        ga.status = "failed"
        await db.commit()
        raise
    except Exception as e:
        ga.status = "failed"
        await db.commit()
        await _add_log(db, book.id, ch.id, ch.index, book_title, "failed", f"Generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))

    # Download audio to per-book folder
    try:
        slug = f"{ch.index:02d}-{ch.title.lower().replace(' ', '-')[:40]}"
        # Use deterministic slug as stored in castwright; but download tries known endpoints
        gdir.mkdir(parents=True, exist_ok=True)
        dest = str(gdir / f"chapter_{ch.index:04d}.mp3")
        # try to find actual slug via events
        actual_slug = None
        for ev in result.get("events", []) or []:
            if ev.get("slug"):
                actual_slug = ev["slug"]
                break
        use_slug = actual_slug or slug
        await castwright_service.download_chapter_audio(cw_book_id, use_slug, dest)
        # also try fallback straight copy if download endpoint not implemented: check Castwright workspace not mounted, so must be HTTP
        if not Path(dest).exists() or Path(dest).stat().st_size < 1024:
            raise CastwrightError("Downloaded audio missing or truncated")
        ga.file_path = dest
        ga.status = "completed"
        try:
            import mutagen  # type: ignore
            from mutagen.mp3 import MP3
            audio = MP3(dest)
            ga.duration = float(audio.info.length) if audio.info else None
        except Exception:
            pass
        await db.commit()
        await _add_log(db, book.id, ch.id, ch.index, book_title, "completed", f"Audio saved to {dest} ({ga.duration or '?'}s)")
        return {"status": "completed", "chapter_id": str(chapter_id), "chapter_index": ch.index, "file_path": dest, "events": result.get("events", [])[:10]}
    except Exception as e:
        logger.exception("Audio download failed for %s ch %s", book_title, ch.index)
        ga.status = "failed"
        await db.commit()
        await _add_log(db, book.id, ch.id, ch.index, book_title, "failed", f"Download failed: {e}")
        raise HTTPException(status_code=502, detail=f"Audio download failed: {e}")


@router.get("/books/{book_id}/chapters/{chapter_id}/audio/stream")
async def stream_generated_chapter(
    book_id: UUID,
    chapter_id: UUID,
    current_user: User = Depends(get_current_user_from_request),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if not book:
        raise HTTPException(status_code=404, detail="Book not found")
    ch = (await db.execute(select(Chapter).where(Chapter.id == chapter_id, Chapter.book_id == book_id))).scalar_one_or_none()
    if not ch:
        raise HTTPException(status_code=404, detail="Chapter not found")
    ga = (await db.execute(select(GeneratedAudio).where(GeneratedAudio.book_id == book_id, GeneratedAudio.chapter_id == chapter_id, GeneratedAudio.status == "completed"))).scalar_one_or_none()
    # fallback to file on disk
    gdir = _generated_dir(book)
    cand = gdir / f"chapter_{ch.index:04d}.mp3"
    path = ga.file_path if ga and ga.file_path and Path(ga.file_path).is_file() else (str(cand) if cand.is_file() else None)
    if not path or not Path(path).is_file():
        raise HTTPException(status_code=404, detail="Generated audio not found for this chapter")
    return FileResponse(path, media_type="audio/mpeg", filename=Path(path).name)


@router.get("/books/{book_id}/chapters/{chapter_id}/audio/download")
async def download_generated_chapter(
    book_id: UUID,
    chapter_id: UUID,
    current_user: User = Depends(get_current_user_from_request),
    db: AsyncSession = Depends(get_db),
):
    return await stream_generated_chapter(book_id, chapter_id, current_user, db)
