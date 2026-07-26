from __future__ import annotations

import hashlib
import os
import re
from pathlib import Path

from app.models.book import BookFormat


def parse_filename(filepath: str, library_path: str | None = None) -> dict:
    path = Path(filepath)
    filename = path.stem
    result = {
        "title": filename,
        "author": None,
        "series": None,
        "series_index": None,
        "file_path": filepath,
        "file_format": classify_file(path.name).value,
    }

    has_folder_metadata = False
    if library_path:
        folder_metadata = parse_folder_layout(path, Path(library_path))
        result.update(
            {
                key: value
                for key, value in folder_metadata.items()
                if value not in (None, "", [], {})
            }
        )
        has_folder_metadata = bool(folder_metadata.get("author") and folder_metadata.get("title"))

    if not has_folder_metadata:
        # Pattern: "Author - Title.epub"
        pattern1 = re.compile(r"^(.+?)\s*-\s*(.+)$")
        m = pattern1.match(filename)
        if m:
            result["author"] = m.group(1).strip()
            result["title"] = m.group(2).strip()

        # Pattern: "Series #1 - Title.m4b" or "Series 1 - Title.epub"
        pattern2 = re.compile(r"^(.+?)\s*#?(\d+(?:\.\d+)?)\s*-\s*(.+)$")
        m = pattern2.match(filename)
        if m:
            result["series"] = m.group(1).strip()
            result["series_index"] = float(m.group(2))
            result["title"] = m.group(3).strip()
        else:
            # Try pattern: "Series - Title" (without index)
            pattern3 = re.compile(r"^(.+?)\s*[-–—]\s*(.+)$")
            m = pattern3.match(filename)
            if m and result["author"] is None:
                result["series"] = m.group(1).strip()
                result["title"] = m.group(2).strip()

    # Clean up title - remove common suffixes
    result["title"] = re.sub(r"\s*\(.*?\)\s*$", "", result["title"]).strip()
    result["title"] = re.sub(r"\s*\[.*?\]\s*$", "", result["title"]).strip()

    return result


def parse_folder_layout(filepath: Path, library_path: Path) -> dict:
    try:
        relative_parts = filepath.relative_to(library_path).parts
    except ValueError:
        return {}

    container_names = {"book", "books", "ebook", "ebooks", "audiobook", "audiobooks"}
    start = 1 if relative_parts[0].lower() in container_names and len(relative_parts) >= 4 else 0
    parts = relative_parts[start:]

    if len(parts) >= 2 and parts[0].lower() in {"chapter", "chapters"}:
        author = library_path.parent.name
        title = library_path.name
        chapter_parts = parts[1:]
        book_folder_path = library_path
    elif len(parts) >= 3 and parts[1].lower() in {"chapter", "chapters"}:
        author = library_path.name
        title = parts[0]
        chapter_parts = parts[2:]
        book_folder_path = library_path / parts[0]
    elif len(parts) >= 3:
        author = parts[0]
        title = parts[1]
        chapter_parts = parts[2:]
        book_folder_path = library_path.joinpath(*relative_parts[: start + 2])
    elif len(parts) >= 2:
        author = library_path.name
        title = parts[0]
        chapter_parts = parts[1:]
        book_folder_path = library_path / parts[0]
    else:
        return {}

    if chapter_parts and chapter_parts[0].lower() in {"chapter", "chapters"}:
        chapter_parts = chapter_parts[1:]
    chapter_source = chapter_parts[-1] if chapter_parts else filepath.name
    chapter_title = _clean_folder_name(Path(chapter_source).stem)

    return {
        "author": _clean_folder_name(author),
        "title": _clean_folder_name(title),
        "book_folder_path": str(book_folder_path),
        "folder_chapter_title": chapter_title,
        "folder_chapter_index": _chapter_index(chapter_source),
    }


def _clean_folder_name(value: str) -> str:
    value = re.sub(r"^\d+\s*[-_.]\s*", "", value).strip()
    return re.sub(r"\s+", " ", value)


def _chapter_index(value: str) -> int | None:
    match = re.search(r"(\d+)", Path(value).stem)
    return int(match.group(1)) if match else None


async def get_file_hash(filepath: str) -> str:
    sha256 = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def classify_file(filename: str) -> BookFormat:
    ext = Path(filename).suffix.lower()
    format_map = {
        ".epub": BookFormat.epub,
        ".pdf": BookFormat.pdf,
        ".mobi": BookFormat.mobi,
        ".azw3": BookFormat.mobi,
        ".cbz": BookFormat.cbz,
        ".cbr": BookFormat.cbr,
        ".mp3": BookFormat.mp3,
        ".m4a": BookFormat.m4b,
        ".m4b": BookFormat.m4b,
        ".flac": BookFormat.flac,
        ".ogg": BookFormat.ogg,
        ".oga": BookFormat.ogg,
        ".aac": BookFormat.aac,
        ".wma": BookFormat.wma,
    }
    return format_map.get(ext, BookFormat.unknown)
