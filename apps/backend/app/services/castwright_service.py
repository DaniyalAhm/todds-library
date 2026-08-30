from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import AsyncIterator

import httpx

from app.config import settings

# Single-chapter concurrency guard: only one Castwright generation at a time per backend.
_TTS_LOCK = asyncio.Lock()


def is_castwright_enabled() -> bool:
    return bool(settings.castwright_enabled and settings.castwright_url)


def castwright_base() -> str:
    return settings.castwright_url.rstrip("/")


def ollama_base() -> str:
    return settings.ollama_url.rstrip("/")


def _timeout() -> float:
    return float(settings.castwright_timeout_s or 300)


class CastwrightError(Exception):
    pass


async def check_health() -> dict:
    """Return health dict from Castwright host."""
    if not is_castwright_enabled():
        return {"enabled": False}
    url = f"{castwright_base()}/api/info"
    # fallback to /api/library if info not present
    async with httpx.AsyncClient(timeout=5) as client:
        for path in ("/api/info", "/api/library", "/health"):
            try:
                r = await client.get(f"{castwright_base()}{path}")
                if r.status_code < 500:
                    return {"enabled": True, "url": castwright_base(), "path": path, "status": r.status_code, "body": r.text[:500]}
            except Exception as e:
                last = str(e)
        return {"enabled": True, "url": castwright_base(), "error": last}


async def list_ollama_models() -> list[str]:
    """List Ollama models via OLLAMA_URL/api/tags (host default localhost:11434)."""
    url = f"{ollama_base()}/api/tags"
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(url)
        r.raise_for_status()
        data = r.json()
        models = data.get("models") or []
        return [m.get("name") or m.get("model") for m in models if m.get("name") or m.get("model")]


async def list_castwright_library() -> list[dict]:
    """Proxy Castwright library (books) if available."""
    async with httpx.AsyncClient(timeout=10) as client:
        r = await client.get(f"{castwright_base()}/api/library")
        if r.status_code == 404:
            return []
        r.raise_for_status()
        data = r.json()
        if isinstance(data, dict) and "books" in data:
            return data["books"]
        if isinstance(data, list):
            return data
        return []


# ── Import helpers ────────────────────────────────────────────────────────

async def import_via_castwright(epub_path: str) -> dict:
    """Upload EPUB bytes to host Castwright /api/import, return staging response."""
    p = Path(epub_path)
    if not p.is_file():
        raise CastwrightError(f"EPUB not found: {epub_path}")
    data = p.read_bytes()
    async with httpx.AsyncClient(timeout=_timeout()) as client:
        files = {"file": (p.name, data, "application/epub+zip")}
        r = await client.post(f"{castwright_base()}/api/import", files=files)
        if r.status_code >= 400:
            raise CastwrightError(f"Castwright import failed {r.status_code}: {r.text[:800]}")
        return r.json()


async def confirm_castwright_book(temp_id: str, author: str, title: str, series: str | None = None, language: str | None = None) -> dict:
    payload: dict = {"tempId": temp_id, "author": author, "title": title}
    if series:
        payload["series"] = series
    if language:
        payload["language"] = language
    async with httpx.AsyncClient(timeout=_timeout()) as client:
        r = await client.post(f"{castwright_base()}/api/books", json=payload)
        if r.status_code >= 400:
            raise CastwrightError(f"Castwright confirm failed {r.status_code}: {r.text[:800]}")
        return r.json()


# ── Analysis ──────────────────────────────────────────────────────────────

async def trigger_analysis(manuscript_id: str, ollama_model: str | None = None) -> dict:
    """Stream SSE from /api/manuscripts/{id}/analysis until result. Return full result."""
    url = f"{castwright_base()}/api/manuscripts/{manuscript_id}/analysis"
    body: dict = {}
    if ollama_model:
        body["model"] = ollama_model
    # Empty body -> default model; server accepts POST with optional json
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", url, json=body if body else None, headers={"Accept": "text/event-stream"}) as resp:
            if resp.status_code >= 400:
                txt = await resp.aread()
                raise CastwrightError(f"Analysis failed {resp.status_code}: {txt[:800]!r}")
            result: dict | None = None
            async for line in resp.aiter_lines():
                if not line or not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload:
                    continue
                try:
                    obj = json.loads(payload)
                except Exception:
                    continue
                # final result has kind: result or response shape
                if obj.get("kind") == "result" and "response" in obj:
                    result = obj["response"]
                elif "characters" in obj or "chapters" in obj:
                    # direct AnalyseResponse
                    result = obj
            if result is None:
                raise CastwrightError("Analysis stream ended without result")
            return result


# ── Generation (chapter-by-chapter, one-at-a-time) ───────────────────────

async def generate_chapter(
    castwright_book_id: str,
    chapter_id: int,
    ollama_model: str | None = None,
    tts_model_key: str | None = None,
) -> dict:
    """Generate a single chapter via Castwright. Enforces global lock.

    Returns dict with castwright events summary.
    """
    if _TTS_LOCK.locked():
        raise CastwrightError("Another chapter is already generating — only one at a time is allowed.")
    async with _TTS_LOCK:
        url = f"{castwright_base()}/api/books/{castwright_book_id}/generation"
        body: dict = {"chapterIds": [chapter_id]}
        # Castwright expects modelKey for TTS; ollama model is for analysis (already done)
        # If provided, pass both
        if tts_model_key:
            body["modelKey"] = tts_model_key
        if ollama_model:
            body["ollamaModel"] = ollama_model

        events: list[dict] = []
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("POST", url, json=body, headers={"Accept": "text/event-stream"}) as resp:
                if resp.status_code >= 400:
                    txt = await resp.aread()
                    raise CastwrightError(f"Generation failed {resp.status_code}: {txt[:800]!r}")
                async for line in resp.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if not payload:
                        continue
                    try:
                        obj = json.loads(payload)
                    except Exception:
                        continue
                    events.append(obj)
                    # break on terminal events
                    if obj.get("type") in ("chapter_complete", "chapter_failed", "done", "generation_complete"):
                        # chapter_complete for our single id is terminal
                        if obj.get("chapterId") == chapter_id or obj.get("type") in ("done", "generation_complete"):
                            break
        return {"events": events}


async def download_chapter_audio(castwright_book_id: str, chapter_slug: str, dest_path: str) -> str:
    """Download generated audio for a chapter slug from host Castwright.

    Tries known endpoints; returns dest_path on success.
    """
    candidates = [
        f"{castwright_base()}/api/books/{castwright_book_id}/audio/{chapter_slug}",
        f"{castwright_base()}/api/books/{castwright_book_id}/chapters/{chapter_slug}/audio",
    ]
    # Castwright serves via workspace audioDir — also try raw file via export manifest
    async with httpx.AsyncClient(timeout=_timeout()) as client:
        for url in candidates:
            try:
                r = await client.get(url)
                if r.status_code == 200 and len(r.content) > 1024:
                    Path(dest_path).parent.mkdir(parents=True, exist_ok=True)
                    Path(dest_path).write_bytes(r.content)
                    return dest_path
            except Exception:
                continue
        # fallback: list library/detail and infer audio url
        try:
            r = await client.get(f"{castwright_base()}/api/books/{castwright_book_id}")
            if r.status_code == 200:
                data = r.json()
                # search for audio urls
                txt = json.dumps(data)
                # not found
                pass
        except Exception:
            pass
    raise CastwrightError(f"Could not download audio for chapter slug {chapter_slug}")


def tts_lock_locked() -> bool:
    return _TTS_LOCK.locked()
