from __future__ import annotations

import os
from pathlib import Path

from app.config import settings


ASR_MODELS_DIR = Path(settings.asr_models_dir)


class ASRError(Exception):
    pass


class TranscriptionResult:
    def __init__(self, text: str, segments: list[dict], language: str = "en"):
        self.text = text
        self.segments = segments
        self.language = language

    def to_srt(self) -> str:
        lines = []
        for i, seg in enumerate(self.segments, 1):
            start = _format_srt_time(seg["start"])
            end = _format_srt_time(seg["end"])
            text = seg["text"].strip()
            lines.append(f"{i}\n{start} --> {end}\n{text}\n")
        return "\n".join(lines)

    def to_vtt(self) -> str:
        lines = ["WEBVTT\n"]
        for seg in self.segments:
            start = _format_srt_time(seg["start"]).replace(",", ".")
            end = _format_srt_time(seg["end"]).replace(",", ".")
            text = seg["text"].strip()
            lines.append(f"{start} --> {end}\n{text}\n")
        return "\n".join(lines)


def _format_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


_MODEL_PIPELINE = None


def _get_model_pipeline():
    global _MODEL_PIPELINE
    if _MODEL_PIPELINE is not None:
        return _MODEL_PIPELINE

    try:
        from transformers import pipeline as hf_pipeline
    except ImportError:
        raise ASRError(
            "ASR dependencies not installed. Install with: pip install torch transformers"
        )

    model_id = settings.asr_model_id

    model_dir = ASR_MODELS_DIR / model_id.replace("/", "--")
    if model_dir.exists() and list(model_dir.glob("*.json")):
        print(f"Loading ASR model from {model_dir}")
        _MODEL_PIPELINE = hf_pipeline(
            "automatic-speech-recognition",
            model=str(model_dir),
        )
        return _MODEL_PIPELINE

    print(f"Downloading ASR model {model_id} (first load)...")
    model_dir.mkdir(parents=True, exist_ok=True)
    _MODEL_PIPELINE = hf_pipeline(
        "automatic-speech-recognition",
        model=model_id,
    )
    try:
        _MODEL_PIPELINE.save_pretrained(str(model_dir))
    except Exception:
        pass
    return _MODEL_PIPELINE


def _ensure_wav(audio_path: str) -> str:
    import subprocess, tempfile, os
    ext = os.path.splitext(audio_path)[1].lower()
    if ext in (".wav", ".flac"):
        return audio_path
    wav = tempfile.mktemp(suffix=".wav")
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-i", audio_path, "-ar", "16000", "-ac", "1", wav],
        check=True, capture_output=True,
    )
    return wav


def transcribe(audio_path: str, language: str | None = None) -> TranscriptionResult:
    pipe = _get_model_pipeline()
    wav_path = _ensure_wav(audio_path)
    generate_kwargs = {}
    if language:
        generate_kwargs["language"] = language

    pipe_kwargs = dict(
        return_timestamps=True,
        chunk_length_s=30,
        stride_length_s=5,
    )
    if generate_kwargs:
        pipe_kwargs["generate_kwargs"] = generate_kwargs
    try:
        result = pipe(wav_path, **pipe_kwargs)
    finally:
        if wav_path != audio_path and os.path.exists(wav_path):
            os.unlink(wav_path)

    segments = []
    if "chunks" in result:
        for chunk in result["chunks"]:
            segments.append({
                "start": chunk.get("timestamp", [0, 0])[0] or 0,
                "end": chunk.get("timestamp", [0, 0])[1] or 0,
                "text": chunk.get("text", ""),
            })
    else:
        segments.append({
            "start": 0,
            "end": 0,
            "text": result.get("text", ""),
        })

    return TranscriptionResult(
        text=result.get("text", ""),
        segments=segments,
        language=language or "en",
    )


def transcribe_chapter(
    audio_path: str,
    output_dir: str,
    chapter_index: int,
    language: str | None = None,
) -> str:
    result = transcribe(audio_path, language)
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    srt_path = os.path.join(output_dir, f"chapter_{chapter_index:04d}.srt")
    with open(srt_path, "w") as f:
        f.write(result.to_srt())

    vtt_path = os.path.join(output_dir, f"chapter_{chapter_index:04d}.vtt")
    with open(vtt_path, "w") as f:
        f.write(result.to_vtt())

    return srt_path
