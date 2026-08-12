from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from app.config import settings
from app.services.asr_service import has_leading_zero_padding

logger = logging.getLogger(__name__)

HEALTH_OK = "ok"
HEALTH_DEGRADED = "degraded"
HEALTH_CORRUPT = "corrupt"
HEALTH_UNREADABLE = "unreadable"
HEALTH_UNCHECKED = "unchecked"

STATUS_PRIORITY = {
    HEALTH_OK: 0,
    HEALTH_DEGRADED: 1,
    HEALTH_CORRUPT: 2,
    HEALTH_UNREADABLE: 3,
    HEALTH_UNCHECKED: 4,
}

REPAIR_DIR = Path(settings.covers_dir).parent / "audio_health"

_PROBE_TIMEOUT_SEC = 300
_DECODE_TIMEOUT_SEC = 3600


@dataclass
class AudioHealthResult:
    path: str
    status: str = HEALTH_UNCHECKED
    format: str | None = None
    codec: str | None = None
    duration: float | None = None
    error_count: int = 0
    issues: list[str] = field(default_factory=list)
    error_sample: str | None = None
    checked_at: str | None = None

    def to_dict(self) -> dict:
        return {
            "path": self.path,
            "status": self.status,
            "format": self.format,
            "codec": self.codec,
            "duration": self.duration,
            "error_count": self.error_count,
            "issues": list(self.issues),
            "error_sample": self.error_sample,
            "checked_at": self.checked_at,
        }


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


def ffprobe_available() -> bool:
    return shutil.which("ffprobe") is not None


def probe_audio(path: str) -> dict | None:
    """Probe an audio file with ffprobe.

    Returns parsed ffprobe JSON (``format``/``streams``) or a dict with an
    ``errors`` key when the container cannot be read. ``None`` means probing
    could not run at all.
    """
    if not ffprobe_available():
        return None

    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=format_name,duration:stream=codec_name,codec_type",
                "-of",
                "json",
                path,
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=_PROBE_TIMEOUT_SEC,
        )
    except Exception:
        logger.exception("Failed to probe audio file %s", path)
        return None

    if proc.returncode != 0:
        sample = (proc.stderr or "").strip()
        return {"errors": [sample] if sample else ["ffprobe reported an error"]}

    try:
        payload = json.loads(proc.stdout or "{}")
    except ValueError:
        return {"errors": ["ffprobe returned unparseable output"]}
    return payload


def _decode_sweep(path: str) -> dict:
    """Decode the full file through ffmpeg to surface damaged frames.

    Uses ``-err_detect explict`` so corrupt bitstream sections raise errors
    that are counted, while ``ignore_err`` semantics are intentionally NOT
    used here: we want failures surfaced for auditing.
    """
    if not ffmpeg_available():
        return {"error_count": 0, "error_sample": None, "skipped": True}

    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-err_detect",
                "explict",
                "-i",
                path,
                "-f",
                "null",
                "-",
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=_DECODE_TIMEOUT_SEC,
        )
    except Exception:
        logger.exception("Audio decode sweep failed for %s", path)
        return {"error_count": 0, "error_sample": None, "skipped": True}

    stderr = proc.stderr or ""
    error_lines = [line.strip() for line in stderr.splitlines() if line.strip()]
    return {
        "error_count": len(error_lines),
        "error_sample": error_lines[0] if error_lines else None,
    }


def check_audio_file(path: str, full_decode: bool = False) -> AudioHealthResult:
    result = AudioHealthResult(path=path, checked_at=_now_iso())

    if not os.path.isfile(path):
        result.status = HEALTH_UNREADABLE
        result.issues.append("file_missing")
        return result

    payload = probe_audio(path)
    if payload is None:
        result.status = HEALTH_UNREADABLE
        result.issues.append("probe_unavailable")
        return result

    if payload.get("errors"):
        result.status = HEALTH_UNREADABLE
        result.error_sample = payload["errors"][0]
        result.issues.append("container_unreadable")
        return result

    fmt = payload.get("format", {})
    result.format = fmt.get("format_name")
    raw_duration = fmt.get("duration")
    try:
        result.duration = float(raw_duration) if raw_duration not in (None, "") else None
    except (TypeError, ValueError):
        result.duration = None

    audio_streams = [
        stream
        for stream in payload.get("streams", [])
        if stream.get("codec_type") == "audio"
    ]
    if audio_streams:
        result.codec = audio_streams[0].get("codec_name")
    else:
        result.issues.append("no_audio_stream")

    if result.duration is None or result.duration <= 0:
        result.issues.append("invalid_duration")

    if has_leading_zero_padding(path):
        result.issues.append("leading_zero_padding")

    if full_decode:
        sweep = _decode_sweep(path)
        result.error_count = sweep.get("error_count", 0)
        result.error_sample = sweep.get("error_sample") or result.error_sample
        if sweep.get("skipped"):
            result.issues.append("decode_check_skipped")
        elif result.error_count > 0:
            result.issues.append("decode_errors")

    result.status = _classify_status(result)
    return result


def _classify_status(result: AudioHealthResult) -> str:
    if "file_missing" in result.issues or "container_unreadable" in result.issues or "probe_unavailable" in result.issues:
        return HEALTH_UNREADABLE
    if "no_audio_stream" in result.issues or result.error_count > 0:
        return HEALTH_CORRUPT
    if "invalid_duration" in result.issues:
        return HEALTH_CORRUPT
    if "leading_zero_padding" in result.issues:
        return HEALTH_DEGRADED
    return HEALTH_OK


def worst_status(statuses: list[str]) -> str:
    if not statuses:
        return HEALTH_UNCHECKED
    return max(statuses, key=lambda item: STATUS_PRIORITY.get(item, STATUS_PRIORITY[HEALTH_UNCHECKED]))


def audit_book_files(files: list[str], full_decode: bool = False) -> list[AudioHealthResult]:
    return [check_audio_file(path, full_decode=full_decode) for path in files]


def build_health_dict(files: list[str], full_decode: bool = False, source: str = "scan") -> dict:
    """Run a health check over explicit audio paths and return a persistable dict."""
    results = audit_book_files(files, full_decode=full_decode)
    statuses = [res.status for res in results]
    return {
        "status": worst_status(statuses),
        "full_decode": full_decode,
        "source": source,
        "files": [res.to_dict() for res in results],
        "checked_at": _now_iso(),
        "issue_count": sum(1 for res in results if res.issues),
    }


def check_book(book, full_decode: bool = False) -> dict:
    """Run a health check across every source file of a book.

    ``book`` is a ``Book`` model instance; the returned dict is safe to persist
    in ``extra_metadata["audio_health"]``.
    """
    metadata = book.extra_metadata or {}
    audio_files = metadata.get("audio_files")
    if not isinstance(audio_files, list):
        audio_path = metadata.get("audiobook_path")
        audio_files = [audio_path] if isinstance(audio_path, str) else []
    files = [str(path) for path in audio_files if isinstance(path, str) and os.path.isfile(path)]
    return build_health_dict(files, full_decode=full_decode)


def repair_cache_key(path: str) -> str:
    stat = os.stat(path)
    return f"{os.path.basename(path)}-{stat.st_size}-{int(stat.st_mtime)}"


def cached_repair_path(path: str) -> str | None:
    if not os.path.isfile(path):
        return None
    output_path = REPAIR_DIR / f"{repair_cache_key(path)}.mp3"
    return str(output_path) if output_path.is_file() else None


def build_repair(path: str) -> str | None:
    """Re-encode a corrupt/degraded source into a clean cached copy.

    The original source file is never modified. Recovery is best-effort: the
    re-encode runs with ``-err_detect ignore_err`` so salvageable audio is
    kept even when some frames are damaged.
    """
    if not os.path.isfile(path):
        return None
    if not ffmpeg_available():
        return None

    cached = cached_repair_path(path)
    if cached is not None:
        return cached

    REPAIR_DIR.mkdir(parents=True, exist_ok=True)
    output_path = REPAIR_DIR / f"{repair_cache_key(path)}.mp3"
    tmp_path = output_path.with_suffix(".tmp.mp3")
    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-err_detect",
                "ignore_err",
                "-i",
                path,
                "-vn",
                "-ac",
                "2",
                "-ar",
                "44100",
                "-c:a",
                "libmp3lame",
                "-q:a",
                "4",
                str(tmp_path),
            ],
            check=False,
            capture_output=True,
            text=True,
            timeout=_DECODE_TIMEOUT_SEC,
        )
        if proc.returncode != 0 or not tmp_path.is_file() or tmp_path.stat().st_size == 0:
            return None
        tmp_path.replace(output_path)
        return str(output_path)
    except Exception:
        logger.exception("Failed to build audio repair copy for %s", path)
        return None
    finally:
        try:
            tmp_path.unlink(missing_ok=True)
        except NameError:
            pass
        except OSError:
            pass


def resolve_repair_path(path: str) -> str | None:
    """Return a usable playback path for ``path``, repairing only when needed."""
    if os.path.isfile(path):
        result = check_audio_file(path, full_decode=False)
        if result.status == HEALTH_OK:
            return path
        if result.status == HEALTH_UNREADABLE and "leading_zero_padding" not in result.issues:
            return None
        repaired = build_repair(path)
        if repaired is not None:
            return repaired
    return path if os.path.isfile(path) else None