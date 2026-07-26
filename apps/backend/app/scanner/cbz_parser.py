from __future__ import annotations

import zipfile
import os
from pathlib import Path


def parse_cbz(filepath: str) -> dict:
    result = {
        "title": None,
        "author": None,
        "page_count": None,
        "description": None,
    }

    ext = Path(filepath).suffix.lower()

    try:
        if ext == ".cbz":
            with zipfile.ZipFile(filepath, "r") as zf:
                image_extensions = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
                images = [
                    name
                    for name in zf.namelist()
                    if Path(name).suffix.lower() in image_extensions
                ]
                result["page_count"] = len(images)
        elif ext == ".cbr":
            # For CBR, just try to count via external unrar or estimate
            result["page_count"] = _count_rar_images(filepath)
    except Exception:
        pass

    return result


def _count_rar_images(filepath: str) -> int | None:
    try:
        import subprocess
        result = subprocess.run(
            ["unrar", "l", filepath],
            capture_output=True,
            text=True,
            timeout=30,
        )
        lines = result.stdout.splitlines()
        image_extensions = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}
        count = 0
        for line in lines:
            parts = line.split()
            if len(parts) >= 1:
                fname = parts[-1]
                if Path(fname).suffix.lower() in image_extensions:
                    count += 1
        return count
    except Exception:
        return None
