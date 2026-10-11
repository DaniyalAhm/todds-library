from __future__ import annotations

import asyncio
import hashlib
import os
import re
from pathlib import Path

from app.models.book import BookFormat


def parse_filename(
    filepath: str,
    library_path: str | None = None,
    dir_cache: dict | None = None,
) -> dict:
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
        folder_metadata = parse_folder_layout(path, Path(library_path), dir_cache)
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


def parse_folder_layout(filepath: Path, library_path: Path, dir_cache: dict | None = None) -> dict:
    try:
        relative_parts = filepath.relative_to(library_path).parts
    except ValueError:
        return {}

    container_names = {"book", "books", "ebook", "ebooks", "audiobook", "audiobooks"}
    start = 1 if relative_parts[0].lower() in container_names and len(relative_parts) >= 4 else 0
    parts = relative_parts[start:]
    # A library pointing at an author folder (e.g. /books/Andy Weir) keeps
    # parent-is-author semantics -- unless we stripped a leading container
    # level (e.g. media/book/Author/Title), which makes it a generic root.
    is_author_library = start == 0 and library_path.name.lower() not in container_names

    series: str | None = None
    series_index: float | None = None

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
    elif len(parts) >= 4:
        # Author/Series/Book/files (author library) or
        # Author/Series/Book/files under a generic root. The middle level is
        # only a series when that directory provably contains 2+ books.
        # Otherwise fall back to Author/Book/files (extra nesting = chapters).
        if is_author_library:
            maybe_series, maybe_title = parts[0], parts[1]
            seq_dir = library_path / maybe_series
            if _is_series_container(seq_dir, dir_cache):
                author = library_path.name
                title = maybe_title
                chapter_parts = parts[2:]
                book_folder_path = library_path / maybe_series / maybe_title
                series = _clean_folder_name(maybe_series)
                _, folder_idx = strip_leading_index(maybe_title)
                # Series position comes from the book folder's leading number
                # ("02 - Dune Messiah" -> 2); fall back to the file's number.
                series_index = float(folder_idx) if folder_idx is not None else None
            else:
                single = _single_book_series_fallback(seq_dir, maybe_series, maybe_title, dir_cache)
                if single is not None:
                    single_series, single_title = single
                    author = library_path.name
                    title = single_title
                    chapter_parts = parts[2:]
                    book_folder_path = library_path / maybe_series / maybe_title
                    series = single_series
                    _, folder_idx = strip_leading_index(maybe_title)
                    series_index = float(folder_idx) if folder_idx is not None else None
                else:
                    author = library_path.name
                    title = parts[0]
                    chapter_parts = parts[1:]
                    book_folder_path = library_path / parts[0]
        else:
            maybe_author, maybe_series, maybe_title = parts[0], parts[1], parts[2]
            seq_dir = library_path.joinpath(*relative_parts[: start + 2])
            if _is_series_container(seq_dir, dir_cache):
                author = maybe_author
                title = maybe_title
                chapter_parts = parts[3:]
                book_folder_path = library_path.joinpath(*relative_parts[: start + 3])
                series = _clean_folder_name(maybe_series)
                _, folder_idx = strip_leading_index(maybe_title)
                series_index = float(folder_idx) if folder_idx is not None else None
            else:
                single = _single_book_series_fallback(seq_dir, maybe_series, maybe_title, dir_cache)
                if single is not None:
                    single_series, single_title = single
                    author = maybe_author
                    title = single_title
                    chapter_parts = parts[3:]
                    book_folder_path = library_path.joinpath(*relative_parts[: start + 3])
                    series = single_series
                    _, folder_idx = strip_leading_index(maybe_title)
                    series_index = float(folder_idx) if folder_idx is not None else None
                else:
                    author = parts[0]
                    title = parts[1]
                    chapter_parts = parts[2:]
                    book_folder_path = library_path.joinpath(*relative_parts[: start + 2])
    elif len(parts) >= 3:
        if is_author_library:
            # Library points at an author folder: Author/Series/Book/files or
            # Author/Book/nested/files. Only the first form yields a series,
            # gated on the middle directory containing 2+ books.
            maybe_series, maybe_title = parts[0], parts[1]
            seq_dir = library_path / maybe_series
            if _is_series_container(seq_dir, dir_cache):
                author = library_path.name
                title = maybe_title
                chapter_parts = parts[2:]
                book_folder_path = library_path / maybe_series / maybe_title
                series = _clean_folder_name(maybe_series)
                _, folder_idx = strip_leading_index(maybe_title)
                series_index = float(folder_idx) if folder_idx is not None else None
            else:
                single = _single_book_series_fallback(seq_dir, maybe_series, maybe_title, dir_cache)
                if single is not None:
                    single_series, single_title = single
                    author = library_path.name
                    title = single_title
                    chapter_parts = parts[2:]
                    book_folder_path = library_path / maybe_series / maybe_title
                    series = single_series
                    _, folder_idx = strip_leading_index(maybe_title)
                    series_index = float(folder_idx) if folder_idx is not None else None
                else:
                    # Author/Book/nested/files with no proven series: the book is
                    # parts[0], author stays the library folder.
                    author = library_path.name
                    title = parts[0]
                    chapter_parts = parts[1:]
                    book_folder_path = library_path / parts[0]
        else:
            author = parts[0]
            title = parts[1]
            chapter_parts = parts[2:]
            book_folder_path = library_path.joinpath(*relative_parts[: start + 2])
    elif len(parts) >= 2:
        # When library points to a generic container (e.g. /books), parts[0] is the
        # author and the file lives flat under the author folder. When it points
        # to an author folder (e.g. /books/Andy Weir), library_path.name is the author.
        if library_path.name.lower() in container_names:
            author = parts[0]
            title = _clean_folder_name(Path(parts[1]).stem)
            # folder that groups this book – still the author folder for flat files
            # (audio in a subfolder will have len>=3 and gets the correct /Author/Title path)
            chapter_parts = parts[1:]
            book_folder_path = library_path / parts[0]
        else:
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

    # A lone subdirectory (e.g. only "Dune Messiah" under an author folder)
    # is a single book, not a series -- leave series unset so metadata
    # providers or "Series #N - Title" filenames supply it, if at all.
    if series_index is None and series is not None:
        _, file_idx = strip_leading_index(Path(chapter_source).stem)
        if file_idx is not None:
            series_index = float(file_idx)

    result = {
        "author": _clean_folder_name(author),
        "title": _clean_folder_name(title),
        "book_folder_path": str(book_folder_path),
        "folder_chapter_title": chapter_title,
        "folder_chapter_index": _chapter_index(chapter_source),
    }
    if series:
        result["series"] = series
    if series_index is not None:
        result["series_index"] = series_index
    return result


def strip_leading_index(value: str) -> tuple[str, int | None]:
    """Split an optional leading track/sequence number from a folder name.

    Returns (clean_name, index). "02 - Dune Messiah" -> ("Dune Messiah", 2);
    "Dune Messiah" -> ("Dune Messiah", None). Supports "02.", "02_", "02-",
    and "#2 -" style prefixes, including decimals ("1.5 - Interlude").
    """
    m = re.match(r"^\s*#?(\d+(?:\.\d+)?)\s*[-_.]\s*(.+)$", value.strip())
    if m:
        try:
            return (re.sub(r"\s+", " ", m.group(2).strip()), int(float(m.group(1))))
        except (TypeError, ValueError):
            pass
    return (re.sub(r"\s+", " ", value.strip()), None)


_MEDIA_EXTENSIONS = {
    ".epub", ".pdf", ".mobi", ".azw3", ".cbz", ".cbr",
    ".mp3", ".m4a", ".m4b", ".flac", ".ogg", ".oga", ".aac", ".wma",
}


def _child_is_book_dir(child: Path, dir_cache: dict | None = None) -> bool:
    """True when a subdirectory looks like one book.

    Accepts media files directly inside, or one level deeper (e.g.
    ``Book/Chapters/track.mp3``). Anything unreadable returns False.
    Results are memoized in ``dir_cache`` (per-scan) when provided.
    """
    if dir_cache is not None:
        key = f"bookdir:{child}"
        if key in dir_cache:
            return dir_cache[key]
    result = _child_is_book_dir_uncached(child)
    if dir_cache is not None:
        dir_cache[f"bookdir:{child}"] = result
    return result


def _child_is_book_dir_uncached(child: Path) -> bool:
    try:
        for grandchild in child.iterdir():
            try:
                if grandchild.is_file() and grandchild.suffix.lower() in _MEDIA_EXTENSIONS:
                    return True
                if grandchild.is_dir() and any(
                    gg.is_file() and gg.suffix.lower() in _MEDIA_EXTENSIONS
                    for gg in grandchild.iterdir()
                ):
                    return True
            except OSError:
                continue
    except OSError:
        return False
    return False


def _is_series_container(dir_path: Path, dir_cache: dict | None = None) -> bool:
    """True only when a directory provably contains a series.

    Counts book-like children: subdirectories holding media files, plus
    loose media files directly inside. Folders named exactly
    "chapter"/"chapters" are chapter containers of the parent book, not
    sibling books, and are excluded. Requires >= 2 so a lone "Dune
    Messiah" folder under an author is treated as one book, not a series.
    Missing/unreadable dirs return False (fail closed, no series invented).
    Results are memoized in ``dir_cache`` (per-scan) when provided.
    """
    if dir_cache is not None:
        key = f"series:{dir_path}"
        if key in dir_cache:
            return dir_cache[key]
    result = _is_series_container_uncached(dir_path, dir_cache)
    if dir_cache is not None:
        dir_cache[f"series:{dir_path}"] = result
    return result


def _is_series_container_uncached(dir_path: Path, dir_cache: dict | None = None) -> bool:
    try:
        if not dir_path.is_dir():
            return False
        book_like = 0
        for child in dir_path.iterdir():
            try:
                if child.is_dir():
                    if child.name.lower() in {"chapter", "chapters"}:
                        continue
                    if _child_is_book_dir(child, dir_cache):
                        book_like += 1
                elif child.is_file() and child.suffix.lower() in _MEDIA_EXTENSIONS:
                    book_like += 1
            except OSError:
                continue
            if book_like >= 2:
                return True
        return False
    except OSError:
        return False


def _only_book_child(dir_path: Path, dir_cache: dict | None = None) -> Path | None:
    """Return the single book-like child dir, or None.

    Used for single-book series folders (e.g. ``The Dune Sequence/``
    containing only ``Dune Messiah/``). Unlike ``_is_series_container``
    (which requires >= 2), this detects the lone-book case so the file
    can still be grouped under the deeper book folder instead of the
    series folder. ``chapter``/``chapters`` containers are excluded, and
    loose media files disqualify (that layout is Author/Book/files, not
    Author/Series/Book/files). Results are memoized in ``dir_cache``
    (per-scan) when provided.
    """
    if dir_cache is not None:
        key = f"only:{dir_path}"
        if key in dir_cache:
            return dir_cache[key]
    result = _only_book_child_uncached(dir_path, dir_cache)
    if dir_cache is not None:
        dir_cache[f"only:{dir_path}"] = result
    return result


def _only_book_child_uncached(dir_path: Path, dir_cache: dict | None = None) -> Path | None:
    try:
        if not dir_path.is_dir():
            return None
        candidates: list[Path] = []
        for child in dir_path.iterdir():
            try:
                if child.is_file() and child.suffix.lower() in _MEDIA_EXTENSIONS:
                    return None
                if child.is_dir():
                    if child.name.lower() in {"chapter", "chapters"}:
                        continue
                    if _child_is_book_dir(child, dir_cache):
                        candidates.append(child)
            except OSError:
                continue
        if len(candidates) == 1:
            return candidates[0]
        return None
    except OSError:
        return None


def _single_book_series_fallback(
    seq_dir: Path, maybe_series: str, maybe_title: str, dir_cache: dict | None = None
) -> tuple[str, str] | None:
    """Return (series, title) when a series folder holds exactly one book.

    Prevents grouping ``Author/Series/Book/files`` at the series level
    (title="The Dune Sequence") just because the series currently has a
    single book. Returns None when the layout does not match.
    """
    only = _only_book_child(seq_dir, dir_cache)
    if only is None:
        return None
    if _clean_folder_name(only.name) != _clean_folder_name(maybe_title):
        return None
    return (_clean_folder_name(maybe_series), _clean_folder_name(maybe_title))


def _clean_folder_name(value: str) -> str:
    clean, _ = strip_leading_index(value)
    return clean


def _chapter_index(value: str) -> int | None:
    # Prefer the trailing number ("Dune Part 2 - 01" -> 1, not 2) so
    # part/volume prefixes don't collapse distinct tracks onto one index.
    numbers = re.findall(r"(\d+)", Path(value).stem)
    return int(numbers[-1]) if numbers else None


async def get_file_hash(filepath: str) -> str:
    # Offload the blocking full-file read so concurrent scans/hashes
    # don't stall the event loop.
    return await asyncio.to_thread(_hash_file_contents, filepath)


def _hash_file_contents(filepath: str) -> str:
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
