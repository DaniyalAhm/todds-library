from __future__ import annotations

import json
import logging
import os
import math
import shutil
import subprocess
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from app.config import settings


logger = logging.getLogger(__name__)
ASR_MODELS_DIR = Path(settings.asr_models_dir)
LONG_SOURCE_CHUNK_SECONDS = 30 * 60
_MODEL_ALIASES = {
    "openai/whisper-tiny": "tiny",
    "openai/whisper-base": "base",
    "openai/whisper-small": "small",
    "openai/whisper-medium": "medium",
    "openai/whisper-large": "large-v3",
    "openai/whisper-large-v1": "large-v1",
    "openai/whisper-large-v2": "large-v2",
    "openai/whisper-large-v3": "large-v3",
    "openai/whisper-large-v3-turbo": "turbo",
}


@dataclass
class SubtitleResult:
    srt_path: str
    vtt_path: str
    json_path: str
    language: str
    model_id: str
    cue_count: int
    word_count: int
    duration_sec: float
    cues: list[dict] = field(default_factory=list)


class ASRError(Exception):
    pass


class TranscriptionResult:
    def __init__(self, text: str, segments: list[dict], language: str = "en"):
        self.text = text
        self.segments = segments
        self.language = language

    @property
    def cue_count(self) -> int:
        return len(self.segments)

    @property
    def word_count(self) -> int:
        return sum(len(seg.get("words") or []) for seg in self.segments)

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

    def to_json(self) -> str:
        return json.dumps(
            {
                "language": self.language,
                "text": self.text,
                "cues": [
                    {
                        "start": seg["start"],
                        "end": seg["end"],
                        "text": seg["text"].strip(),
                        "words": seg.get("words") or [],
                    }
                    for seg in self.segments
                ],
            },
            ensure_ascii=False,
        )


def _format_srt_time(seconds: float) -> str:
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int((seconds - int(seconds)) * 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def probe_audio_duration(audio_path: str) -> float | None:
    if not shutil.which("ffprobe"):
        return None

    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                audio_path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(proc.stdout or "{}")
        duration = payload.get("format", {}).get("duration")
        if duration in (None, ""):
            return None
        parsed = float(duration)
        return parsed if parsed > 0 else None
    except Exception:
        logger.exception("Failed to probe audio duration for %s", audio_path)
        return None


def should_use_chunked_transcription(
    *,
    audio_source_count: int,
    chapter_count: int,
    audio_path: str,
    duration_sec: float | None,
    threshold_sec: int = LONG_SOURCE_CHUNK_SECONDS,
) -> bool:
    if audio_source_count != 1 or chapter_count != 1:
        return False

    duration = duration_sec if duration_sec and duration_sec > 0 else probe_audio_duration(audio_path)
    return bool(duration and duration > threshold_sec)


_MODEL_PIPELINE = None
_MODEL_PIPELINE_CONFIG: tuple[str, str, str, int | None] | None = None


def _normalize_model_id(model_id: str) -> str:
    return _MODEL_ALIASES.get(model_id, model_id)


def _resolve_device() -> str:
    device_setting = settings.asr_device
    if device_setting in ("cuda", "cpu"):
        return device_setting

    try:
        import torch

        return "cuda" if torch.cuda.is_available() else "cpu"
    except Exception:
        return "cpu"


def _resolve_compute_type(device: str) -> str:
    return settings.asr_compute_type if settings.asr_compute_type in ("float16", "float32") else "float32"


def _resolve_device_index(device: str) -> int | None:
    if device != "cuda":
        return None
    return settings.asr_gpu_index


def apply_runtime_settings(db_settings: dict[str, str]) -> None:
    reset_required = False

    asr_device = db_settings.get("asr_device")
    if asr_device in ("auto", "cuda", "cpu") and settings.asr_device != asr_device:
        os.environ["ASR_DEVICE"] = asr_device
        settings.asr_device = asr_device
        reset_required = True

    asr_gpu_index = db_settings.get("asr_gpu_index")
    if asr_gpu_index is not None:
        try:
            parsed_gpu_index = int(asr_gpu_index)
        except ValueError:
            parsed_gpu_index = 0
        parsed_gpu_index = max(parsed_gpu_index, 0)
        if settings.asr_gpu_index != parsed_gpu_index:
            os.environ["ASR_GPU_INDEX"] = str(parsed_gpu_index)
            settings.asr_gpu_index = parsed_gpu_index
            reset_required = True

    asr_compute_type = db_settings.get("asr_compute_type")
    if asr_compute_type in ("float16", "float32") and settings.asr_compute_type != asr_compute_type:
        os.environ["ASR_COMPUTE_TYPE"] = asr_compute_type
        settings.asr_compute_type = asr_compute_type
        reset_required = True

    asr_model_id = db_settings.get("asr_model_id")
    if asr_model_id and settings.asr_model_id != asr_model_id:
        os.environ["ASR_MODEL_ID"] = asr_model_id
        settings.asr_model_id = asr_model_id
        reset_required = True

    if reset_required:
        reset_model_pipeline()


def reset_model_pipeline() -> None:
    global _MODEL_PIPELINE, _MODEL_PIPELINE_CONFIG
    _MODEL_PIPELINE = None
    _MODEL_PIPELINE_CONFIG = None


def _get_model_pipeline():
    global _MODEL_PIPELINE, _MODEL_PIPELINE_CONFIG

    model_id = _normalize_model_id(settings.asr_model_id)
    device = _resolve_device()
    compute_type = _resolve_compute_type(device)
    device_index = _resolve_device_index(device)
    if (
        _MODEL_PIPELINE is not None
        and _MODEL_PIPELINE_CONFIG is not None
        and _MODEL_PIPELINE_CONFIG[0] == model_id
        and _MODEL_PIPELINE_CONFIG[1] == device
        and _MODEL_PIPELINE_CONFIG[2] == compute_type
        and _MODEL_PIPELINE_CONFIG[3] == device_index
    ):
        return _MODEL_PIPELINE

    _MODEL_PIPELINE = None

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        raise ASRError(
            "ASR dependencies not installed. Install with: pip install faster-whisper"
        )

    logger.info(
        "Loading faster-whisper model %s (device=%s, device_index=%s, compute_type=%s)",
        model_id,
        device,
        device_index,
        compute_type,
    )
    model_kwargs = {
        "device": device,
        "compute_type": compute_type,
        "download_root": str(ASR_MODELS_DIR),
    }
    if device_index is not None:
        model_kwargs["device_index"] = device_index
    _MODEL_PIPELINE = WhisperModel(model_id, **model_kwargs)
    _MODEL_PIPELINE_CONFIG = (model_id, device, compute_type, device_index)
    return _MODEL_PIPELINE


_COVERAGE_THRESHOLD = 0.7


def transcribe(
    audio_path: str,
    language: str | None = None,
    batch_size: int = 1,
    chunk_length_s: int = 30,
    vad_filter: bool = False,
) -> TranscriptionResult:
    model = _get_model_pipeline()
    result = _transcribe_source(model, audio_path, language, batch_size, chunk_length_s, vad_filter)

    duration_sec = probe_audio_duration(audio_path)
    coverage = _result_coverage(result, duration_sec)
    if coverage < _COVERAGE_THRESHOLD:
        fallback = _retranscribe_via_ffmpeg(
            model,
            audio_path,
            duration_sec,
            language,
            batch_size,
            chunk_length_s,
            vad_filter,
            previous_coverage=coverage,
        )
        if fallback is not None:
            result = fallback

    if result.word_count == 0:
        raise ASRError(
            f"Transcription produced no words for {os.path.basename(audio_path)}"
        )

    return result


def _transcribe_source(
    model,
    audio_path: str,
    language: str | None,
    batch_size: int,
    chunk_length_s: int,
    vad_filter: bool,
) -> TranscriptionResult:
    transcribe_model = model
    transcribe_kwargs = dict(
        language=language,
        word_timestamps=True,
        chunk_length=chunk_length_s,
        vad_filter=vad_filter,
    )

    if batch_size > 1 and vad_filter:
        try:
            from faster_whisper import BatchedInferencePipeline
        except ImportError:
            raise ASRError(
                "Batched ASR dependencies not installed. Install with: pip install faster-whisper"
            )
        transcribe_model = BatchedInferencePipeline(model=model)
        transcribe_kwargs["batch_size"] = batch_size

    t0 = time.time()
    logger.info(
        "Starting transcription for %s (language=%s, batch_size=%s, chunk_length_s=%s, vad_filter=%s)",
        os.path.basename(audio_path),
        language or "auto",
        batch_size,
        chunk_length_s,
        vad_filter,
    )
    segments_iter, info = transcribe_model.transcribe(audio_path, **transcribe_kwargs)
    segments = [_segment_to_dict(segment) for segment in segments_iter]
    text = "".join(segment["text"] for segment in segments).strip()
    detected_language = getattr(info, "language", None) or language or "en"
    elapsed = time.time() - t0
    logger.info(
        "Completed transcription for %s in %.1fs (%s words, language=%s)",
        os.path.basename(audio_path),
        elapsed,
        len(text.split()),
        detected_language,
    )
    return TranscriptionResult(text=text, segments=segments, language=detected_language)


def _result_coverage(result: TranscriptionResult, duration_sec: float | None) -> float:
    if not result.segments or not duration_sec or duration_sec <= 0:
        return 0.0
    max_end = max(seg.get("end", 0.0) or 0.0 for seg in result.segments)
    return min(1.0, max_end / duration_sec)


def _retranscribe_via_ffmpeg(
    model,
    audio_path: str,
    duration_sec: float | None,
    language: str | None,
    batch_size: int,
    chunk_length_s: int,
    vad_filter: bool,
    *,
    previous_coverage: float,
) -> TranscriptionResult | None:
    if not duration_sec or duration_sec <= 0:
        return None

    logger.warning(
        "Transcription coverage for %s is %.0f%% of the source duration; "
        "re-decoding through ffmpeg and retrying (possible corrupt audio)",
        os.path.basename(audio_path),
        previous_coverage * 100,
    )

    tmp_path = None
    try:
        tmp_path = _extract_audio_chunk(audio_path, 0.0, duration_sec)
        fallback = _transcribe_source(
            model,
            tmp_path,
            language,
            batch_size,
            chunk_length_s,
            vad_filter,
        )
        if _result_coverage(fallback, duration_sec) > previous_coverage:
            return fallback
    except Exception:
        logger.exception("ffmpeg fallback transcription failed for %s", audio_path)
    finally:
        if tmp_path is not None:
            try:
                os.unlink(tmp_path)
            except FileNotFoundError:
                pass
    return None


def transcribe_chapter(
    audio_path: str,
    output_dir: str,
    chapter_index: int,
    language: str | None = None,
    batch_size: int = 1,
    chunk_length_s: int = 30,
    vad_filter: bool = False,
) -> SubtitleResult:
    t0 = time.time()
    result = transcribe(audio_path, language, batch_size, chunk_length_s, vad_filter)
    elapsed = time.time() - t0
    logger.info(
        "Completed chapter %s transcription in %.1fs (%s cues, %s words)",
        chapter_index,
        elapsed,
        result.cue_count,
        result.word_count,
    )
    return _write_chapter_subtitle_files(result, output_dir, chapter_index)


def transcribe_chapter_chunked(
    audio_path: str,
    output_dir: str,
    chapter_index: int,
    language: str | None = None,
    batch_size: int = 1,
    chunk_length_s: int = 30,
    vad_filter: bool = False,
    duration_sec: float | None = None,
    chunk_duration_s: int = LONG_SOURCE_CHUNK_SECONDS,
    progress_callback: Callable[[int, int, float, float], None] | None = None,
) -> SubtitleResult:
    t0 = time.time()
    output_path = Path(output_dir)
    partial_dir = output_path / ".partials" / f"chapter_{chapter_index:04d}"

    result = transcribe_full_source(
        audio_path,
        language,
        batch_size,
        chunk_length_s,
        vad_filter,
        duration_sec=duration_sec,
        chunk_duration_s=chunk_duration_s,
        progress_callback=progress_callback,
        resume_dir=str(partial_dir),
    )
    elapsed = time.time() - t0
    logger.info(
        "Completed chapter %s transcription in %.1fs (%s cues, %s words)",
        chapter_index,
        elapsed,
        result.cue_count,
        result.word_count,
    )
    subtitle_result = _write_chapter_subtitle_files(result, output_dir, chapter_index)
    logger.info(
        "Completed chunked chapter %s transcription in %.1fs (%s cues, %s words)",
        chapter_index,
        elapsed,
        subtitle_result.cue_count,
        subtitle_result.word_count,
    )

    try:
        shutil.rmtree(partial_dir)
    except Exception:
        logger.exception("Failed to clean subtitle partial directory %s", partial_dir)

    return subtitle_result


def transcribe_full_source(
    audio_path: str,
    language: str | None = None,
    batch_size: int = 1,
    chunk_length_s: int = 30,
    vad_filter: bool = False,
    duration_sec: float | None = None,
    chunk_duration_s: int = LONG_SOURCE_CHUNK_SECONDS,
    progress_callback: Callable[[int, int, float, float], None] | None = None,
    resume_dir: str | None = None,
) -> TranscriptionResult:
    duration = duration_sec if duration_sec and duration_sec > 0 else probe_audio_duration(audio_path)
    if not duration or duration <= 0:
        raise ASRError("Unable to determine audio duration for chunked transcription")

    if duration <= chunk_duration_s:
        return transcribe(audio_path, language, batch_size, chunk_length_s, vad_filter)

    partial_dir = Path(resume_dir) if resume_dir else None
    if partial_dir is not None:
        partial_dir.mkdir(parents=True, exist_ok=True)

    total_chunks = max(1, math.ceil(duration / chunk_duration_s))
    chunk_results: list[dict] = []
    t0 = time.time()
    logger.info(
        "Starting chunked transcription for %s (%s chunks, %.1fs total)",
        os.path.basename(audio_path),
        total_chunks,
        duration,
    )

    for zero_based_index in range(total_chunks):
        chunk_number = zero_based_index + 1
        start_sec = zero_based_index * chunk_duration_s
        end_sec = min(duration, start_sec + chunk_duration_s)
        partial_path = partial_dir / f"chunk_{chunk_number:06d}.json" if partial_dir else None

        try:
            if partial_path is not None and partial_path.exists():
                chunk_data = _load_chunk_partial(partial_path)
                logger.info(
                    "Skipping completed chunk %s/%s",
                    chunk_number,
                    total_chunks,
                )
            else:
                tmp_path = _extract_audio_chunk(audio_path, start_sec, end_sec - start_sec)
                try:
                    chunk_result = transcribe(
                        tmp_path,
                        language,
                        batch_size,
                        chunk_length_s,
                        vad_filter,
                    )
                    chunk_data = {
                        "chunk_index": chunk_number,
                        "start_sec": start_sec,
                        "end_sec": end_sec,
                        "language": chunk_result.language,
                        "text": chunk_result.text,
                        "segments": _offset_segments(chunk_result.segments, start_sec),
                    }
                    if partial_path is not None:
                        _write_chunk_partial(partial_path, chunk_data)
                finally:
                    try:
                        os.unlink(tmp_path)
                    except FileNotFoundError:
                        pass

            chunk_results.append(chunk_data)
            if progress_callback is not None:
                progress_callback(chunk_number, total_chunks, start_sec, end_sec)
        except Exception as exc:
            raise ASRError(f"Chunk {chunk_number}/{total_chunks} failed: {exc}") from exc

    return _stitch_chunk_results(chunk_results, language)


def _extract_audio_chunk(audio_path: str, start_sec: float, duration_sec: float) -> str:
    if not shutil.which("ffmpeg"):
        raise ASRError("ffmpeg is required for chunked subtitle generation")

    fd, tmp_path = tempfile.mkstemp(prefix="todds-library-subtitle-", suffix=".wav", dir="/tmp")
    os.close(fd)
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-ss",
                f"{start_sec:.3f}",
                "-t",
                f"{duration_sec:.3f}",
                "-i",
                audio_path,
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-f",
                "wav",
                tmp_path,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return tmp_path
    except Exception:
        try:
            os.unlink(tmp_path)
        except FileNotFoundError:
            pass
        raise


def _offset_segments(segments: list[dict], offset_sec: float) -> list[dict]:
    offset_segments = []
    for segment in segments:
        offset_words = []
        for word in segment.get("words") or []:
            offset_words.append({
                **word,
                "start": float(word.get("start", 0.0) or 0.0) + offset_sec,
                "end": float(word.get("end", 0.0) or 0.0) + offset_sec,
            })

        offset_segments.append({
            **segment,
            "start": float(segment.get("start", 0.0) or 0.0) + offset_sec,
            "end": float(segment.get("end", 0.0) or 0.0) + offset_sec,
            "words": offset_words,
        })
    return offset_segments


def _write_chunk_partial(partial_path: Path, chunk_data: dict) -> None:
    tmp_path = partial_path.with_suffix(".tmp")
    tmp_path.write_text(json.dumps(chunk_data, ensure_ascii=False), encoding="utf-8")
    tmp_path.replace(partial_path)


def _load_chunk_partial(partial_path: Path) -> dict:
    payload = json.loads(partial_path.read_text(encoding="utf-8"))
    if not isinstance(payload.get("segments"), list):
        raise ASRError(f"Invalid subtitle partial: {partial_path}")
    return payload


def _stitch_chunk_results(chunk_results: list[dict], fallback_language: str | None = None) -> TranscriptionResult:
    ordered = sorted(chunk_results, key=lambda item: item.get("chunk_index", 0))
    segments: list[dict] = []
    text_parts: list[str] = []
    detected_language = fallback_language or "en"
    for chunk in ordered:
        if chunk.get("language"):
            detected_language = chunk["language"]
        text = (chunk.get("text") or "").strip()
        if text:
            text_parts.append(text)
        segments.extend(chunk.get("segments") or [])

    return TranscriptionResult(
        text=" ".join(text_parts).strip(),
        segments=segments,
        language=detected_language,
    )


def _write_chapter_subtitle_files(
    result: TranscriptionResult,
    output_dir: str,
    chapter_index: int,
) -> SubtitleResult:
    Path(output_dir).mkdir(parents=True, exist_ok=True)

    srt_path = os.path.join(output_dir, f"chapter_{chapter_index:04d}.srt")
    with open(srt_path, "w", encoding="utf-8") as f:
        f.write(result.to_srt())

    vtt_path = os.path.join(output_dir, f"chapter_{chapter_index:04d}.vtt")
    with open(vtt_path, "w", encoding="utf-8") as f:
        f.write(result.to_vtt())

    json_path = os.path.join(output_dir, f"chapter_{chapter_index:04d}.json")
    json_str = result.to_json()
    with open(json_path, "w", encoding="utf-8") as f:
        f.write(json_str)

    cues_list = json.loads(json_str).get("cues", [])
    cue_count = len(cues_list)
    word_count = sum(len(cue.get("words", [])) for cue in cues_list)
    duration_sec = max((cue.get("end", 0) for cue in cues_list), default=0.0)

    return SubtitleResult(
        srt_path=srt_path,
        vtt_path=vtt_path,
        json_path=json_path,
        language=result.language,
        model_id=_normalize_model_id(settings.asr_model_id),
        cue_count=cue_count,
        word_count=word_count,
        duration_sec=duration_sec,
        cues=cues_list,
    )


def _segment_to_dict(segment) -> dict:
    return {
        "start": float(getattr(segment, "start", 0.0) or 0.0),
        "end": float(getattr(segment, "end", 0.0) or 0.0),
        "text": getattr(segment, "text", "") or "",
        "words": [_word_to_dict(word) for word in (getattr(segment, "words", None) or [])],
    }


def _word_to_dict(word) -> dict:
    return {
        "start": float(getattr(word, "start", 0.0) or 0.0),
        "end": float(getattr(word, "end", 0.0) or 0.0),
        "text": (getattr(word, "word", "") or "").strip(),
    }
