from __future__ import annotations

import json
import os
import uuid
from pathlib import Path
from typing import AsyncGenerator

from app.config import settings


TTS_MODELS_DIR = Path(settings.tts_models_dir)
CLONED_VOICES_INDEX = TTS_MODELS_DIR / "cloned_voices.json"
GENERATED_AUDIO_DIR = Path(settings.tts_models_dir).parent / "generated_audio"


class TTSError(Exception):
    pass


def _load_cloned_voices() -> dict:
    if CLONED_VOICES_INDEX.exists():
        try:
            return json.loads(CLONED_VOICES_INDEX.read_text())
        except Exception:
            return {}
    return {}


def _save_cloned_voices(voices: dict) -> None:
    TTS_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    CLONED_VOICES_INDEX.write_text(json.dumps(voices, indent=2))


def list_available_voices() -> list[dict]:
    voices = []
    voices.append({"id": "default", "name": "Default Voice", "language": "en", "is_cloned": False})
    cloned = _load_cloned_voices()
    for voice_id, info in cloned.items():
        voices.append({
            "id": voice_id,
            "name": info.get("name", voice_id),
            "language": info.get("language", "en"),
            "is_cloned": True,
        })
    return voices


def _get_pocket_tts():
    try:
        from pocket_tts import TTSModel
    except ImportError:
        raise TTSError("pocket-tts is not installed. Install with: pip install pocket-tts")
    return TTSModel.load_model(language="english")


def _default_model_state(tts):
    from pocket_tts.modules.stateful_module import init_states
    return init_states(tts.flow_lm, batch_size=1, sequence_length=1)


async def synthesize(text: str, voice_id: str | None = None) -> bytes:
    import soundfile as sf
    import io
    import torch

    voice = voice_id or "default"
    tts = _get_pocket_tts()

    if voice == "default":
        state = _default_model_state(tts)
        audio_tensor = tts.generate_audio(state, text)
    else:
        cloned = _load_cloned_voices()
        if voice not in cloned:
            raise TTSError(f"Voice '{voice}' not found")
        ref_audio_path = cloned[voice]["file_path"]
        state = tts.get_state_for_audio_prompt(ref_audio_path)
        audio_tensor = tts.generate_audio(state, text)

    audio_np = audio_tensor.cpu().numpy()
    buf = io.BytesIO()
    sf.write(buf, audio_np, samplerate=tts.sample_rate, format="WAV")
    return buf.getvalue()


def clone_voice(name: str, audio_bytes: bytes) -> str:
    voice_id = name.lower().replace(" ", "_").replace("/", "_")
    TTS_MODELS_DIR.mkdir(parents=True, exist_ok=True)
    clone_dir = TTS_MODELS_DIR / "clones"
    clone_dir.mkdir(exist_ok=True)

    file_path = clone_dir / f"{voice_id}.wav"
    file_path.write_bytes(audio_bytes)

    cloned = _load_cloned_voices()
    cloned[voice_id] = {
        "name": name,
        "file_path": str(file_path),
        "language": "en",
    }
    _save_cloned_voices(cloned)
    return voice_id


def delete_cloned_voice(voice_id: str) -> None:
    cloned = _load_cloned_voices()
    if voice_id not in cloned:
        raise TTSError(f"Voice '{voice_id}' not found")
    file_path = Path(cloned[voice_id]["file_path"])
    if file_path.exists():
        file_path.unlink()
    del cloned[voice_id]
    _save_cloned_voices(cloned)


def _extract_epub_chapters(book_path: str) -> list[dict]:
    from ebooklib import epub
    from bs4 import BeautifulSoup

    book = epub.read_epub(book_path)
    chapters = []
    for i, item in enumerate(book.get_items()):
        if item.get_type() == 9:
            content = item.get_content().decode("utf-8")
            soup = BeautifulSoup(content, "lxml")
            title_tag = soup.find(["h1", "h2", "h3", "h4"])
            title = title_tag.get_text(strip=True) if title_tag else f"Chapter {i + 1}"
            text = soup.get_text(separator=" ", strip=True)
            if text:
                chapters.append({"index": i, "title": title, "text": text})
    return chapters


async def generate_book_audio(
    book_id: uuid.UUID,
    book_path: str,
    voice_id: str,
    chapter_indices: list[int] | None = None,
) -> list[dict]:
    import soundfile as sf
    import torch

    if not os.path.isfile(book_path):
        raise TTSError(f"Book file not found: {book_path}")

    chapters = _extract_epub_chapters(book_path)
    if not chapters:
        raise TTSError("No extractable chapters found in EPUB")

    if chapter_indices is not None:
        chapters = [ch for ch in chapters if ch["index"] in chapter_indices]

    output_dir = GENERATED_AUDIO_DIR / str(book_id)
    output_dir.mkdir(parents=True, exist_ok=True)

    results = []
    tts = _get_pocket_tts()

    for ch in chapters:
        output_path = output_dir / f"chapter_{ch['index']:04d}.wav"

        if voice_id == "default":
            state = _default_model_state(tts)
            audio_tensor = tts.generate_audio(state, ch["text"])
        else:
            cloned = _load_cloned_voices()
            if voice_id not in cloned:
                raise TTSError(f"Voice '{voice_id}' not found")
            ref_audio_path = cloned[voice_id]["file_path"]
            state = tts.get_state_for_audio_prompt(ref_audio_path)
            audio_tensor = tts.generate_audio(state, ch["text"])

        audio_np = audio_tensor.cpu().numpy()
        sf.write(str(output_path), audio_np, samplerate=tts.sample_rate)

        duration = float(len(audio_np)) / float(tts.sample_rate)
        results.append({
            "file_path": str(output_path),
            "duration": duration,
            "chapter_index": ch["index"],
            "title": ch["title"],
        })

    return results
