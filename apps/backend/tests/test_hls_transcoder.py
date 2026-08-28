from __future__ import annotations

import subprocess

import pytest

from app.models.book import Book, BookFormat
from app.models.library import Library, LibraryType
from app.transcoder import hls


def test_audio_range_parser_supports_open_and_suffix_ranges():
    from app.api.audiobooks import _parse_range

    assert _parse_range("bytes=2-5", 10) == (2, 5)
    assert _parse_range("bytes=7-", 10) == (7, 9)
    assert _parse_range("bytes=-4", 10) == (6, 9)


def test_audio_range_parser_rejects_unsatisfiable_ranges():
    from app.api.audiobooks import _parse_range

    with pytest.raises(Exception) as exc:
        _parse_range("bytes=99-100", 10)

    assert getattr(exc.value, "status_code", None) == 416


def test_audio_media_type_supports_mobile_audio_extensions():
    from app.api.audiobooks import _audio_media_type

    assert _audio_media_type("mp3") == "audio/mpeg"
    assert _audio_media_type("m4a") == "audio/mp4"
    assert _audio_media_type("opus") == "audio/ogg"


def test_single_file_hls_transcode_maps_only_audio(monkeypatch, tmp_path):
    calls: list[list[str]] = []

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(hls.subprocess, "run", fake_run)

    playlist = hls.transcode_to_hls("/books/Author/Book/book.m4b", str(tmp_path))

    assert playlist == str(tmp_path / "master.m3u8")
    assert calls
    assert "-map" in calls[0]
    assert calls[0][calls[0].index("-map") + 1] == "0:a:0"
    assert "-vn" in calls[0]
    assert "-sn" in calls[0]
    assert "-dn" in calls[0]
    assert "-hls_version" not in calls[0]


def test_multi_file_hls_transcode_maps_only_audio(monkeypatch, tmp_path):
    calls: list[list[str]] = []

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(hls.subprocess, "run", fake_run)

    playlist = hls.transcode_files_to_hls(
        ["/books/Author/Book/01.m4b", "/books/Author/Book/02.m4b"],
        str(tmp_path),
    )

    assert playlist == str(tmp_path / "master.m3u8")
    assert calls
    assert "-map" in calls[0]
    assert calls[0][calls[0].index("-map") + 1] == "0:a:0"
    assert "-vn" in calls[0]
    assert "-sn" in calls[0]
    assert "-dn" in calls[0]
    assert "-hls_version" not in calls[0]


@pytest.mark.asyncio
async def test_audiobook_download_selects_track(client, db_session, test_user, tmp_path):
    first_track = tmp_path / "01.mp3"
    second_track = tmp_path / "02.mp3"
    first_track.write_bytes(b"first")
    second_track.write_bytes(b"second")
    library = Library(
        name="Audiobooks",
        path=str(tmp_path),
        type=LibraryType.audiobook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)
    book = Book(
        library_id=library.id,
        title="Multi Track",
        author="Author",
        file_path=str(first_track),
        file_format=BookFormat.mp3,
        file_size=first_track.stat().st_size + second_track.stat().st_size,
        file_hash="multi-track",
        extra_metadata={
            "audiobook_path": str(first_track),
            "audiobook_format": "mp3",
            "audio_files": [str(first_track), str(second_track)],
        },
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    response = await client.get(f"/audiobooks/{book.id}/download", params={"track": 1})

    assert response.status_code == 200
    assert response.content == b"second"
    assert response.headers["content-type"].startswith("audio/mpeg")

    missing = await client.get(f"/audiobooks/{book.id}/download", params={"track": 2})
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_audiobook_download_supports_byte_ranges(client, db_session, test_user, tmp_path, monkeypatch):
    from app.api import audiobooks

    async def no_repair(_path: str) -> None:
        return None

    monkeypatch.setattr(audiobooks, "_cached_sanitized_download_path", no_repair)

    track = tmp_path / "book.mp3"
    track.write_bytes(b"0123456789")
    library = Library(
        name="Audiobooks",
        path=str(tmp_path),
        type=LibraryType.audiobook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)
    book = Book(
        library_id=library.id,
        title="Range Book",
        author="Author",
        file_path=str(track),
        file_format=BookFormat.mp3,
        file_size=track.stat().st_size,
        file_hash="range-book",
        extra_metadata={
            "audiobook_path": str(track),
            "audiobook_format": "mp3",
            "audio_files": [str(track)],
        },
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    response = await client.get(
        f"/audiobooks/{book.id}/download",
        headers={"Range": "bytes=2-5"},
    )

    assert response.status_code == 206
    assert response.content == b"2345"
    assert response.headers["accept-ranges"] == "bytes"
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert response.headers["content-length"] == "4"
    assert response.headers["cache-control"] == "no-store"


@pytest.mark.asyncio
async def test_audiobook_download_rejects_invalid_range(client, db_session, test_user, tmp_path, monkeypatch):
    from app.api import audiobooks

    async def no_repair(_path: str) -> None:
        return None

    monkeypatch.setattr(audiobooks, "_cached_sanitized_download_path", no_repair)

    track = tmp_path / "book.mp3"
    track.write_bytes(b"0123456789")
    library = Library(
        name="Audiobooks",
        path=str(tmp_path),
        type=LibraryType.audiobook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)
    book = Book(
        library_id=library.id,
        title="Invalid Range Book",
        author="Author",
        file_path=str(track),
        file_format=BookFormat.mp3,
        file_size=track.stat().st_size,
        file_hash="invalid-range-book",
        extra_metadata={
            "audiobook_path": str(track),
            "audiobook_format": "mp3",
            "audio_files": [str(track)],
        },
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    response = await client.get(
        f"/audiobooks/{book.id}/download",
        headers={"Range": "bytes=99-100"},
    )

    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */10"
