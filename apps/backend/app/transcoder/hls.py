from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path


def transcode_to_hls(
    input_path: str, output_dir: str, segment_duration: int = 10
) -> str:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    playlist_path = output_path / "master.m3u8"

    # HLS v4 with MPEG-TS segments
    cmd = [
        "ffmpeg",
        "-i", input_path,
        "-map", "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",
        "-f", "hls",
        "-hls_time", str(segment_duration),
        "-hls_list_size", "0",
        "-hls_segment_filename", str(output_path / "segment_%05d.ts"),
        "-hls_playlist_type", "vod",
        "-y",
        str(playlist_path),
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=3600,
    )

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg HLS transcoding failed: {result.stderr}")

    return str(playlist_path)


def transcode_files_to_hls(
    input_paths: list[str], output_dir: str, segment_duration: int = 10
) -> str:
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)

    concat_path = output_path / "concat.txt"
    with open(concat_path, "w") as concat_file:
        for input_path in input_paths:
            escaped = str(Path(input_path)).replace("'", "\\'")
            concat_file.write(f"file '{escaped}'\n")

    playlist_path = output_path / "master.m3u8"
    cmd = [
        "ffmpeg",
        "-f", "concat",
        "-safe", "0",
        "-i", str(concat_path),
        "-map", "0:a:0",
        "-vn",
        "-sn",
        "-dn",
        "-c:a", "aac",
        "-b:a", "128k",
        "-ar", "44100",
        "-ac", "2",
        "-f", "hls",
        "-hls_time", str(segment_duration),
        "-hls_list_size", "0",
        "-hls_segment_filename", str(output_path / "segment_%05d.ts"),
        "-hls_playlist_type", "vod",
        "-y",
        str(playlist_path),
    ]

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=3600,
    )

    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg HLS transcoding failed: {result.stderr}")

    return str(playlist_path)


def get_segment(output_dir: str, segment_name: str) -> bytes | None:
    segment_path = Path(output_dir) / segment_name
    if not segment_path.is_file():
        return None

    # Security: prevent path traversal
    try:
        segment_path = segment_path.resolve(strict=True)
        output_dir_resolved = Path(output_dir).resolve()
        if not str(segment_path).startswith(str(output_dir_resolved)):
            return None
    except (ValueError, OSError):
        return None

    with open(segment_path, "rb") as f:
        return f.read()


def cleanup_segments(output_dir: str, keep_days: int = 7) -> None:
    output_path = Path(output_dir)
    if not output_path.is_dir():
        return

    now = time.time()
    cutoff = now - (keep_days * 86400)

    for f in output_path.iterdir():
        if f.suffix in (".ts", ".m3u8"):
            if f.stat().st_mtime < cutoff:
                f.unlink(missing_ok=True)
