from __future__ import annotations

import os
import subprocess
from types import SimpleNamespace

import pytest

from app.api import audio_health as ah_api
from app.models.book import Book, BookFormat
from app.models.library import Library, LibraryType
from app.services import audio_health_service as ahs
from app.services import scanner_service

HEALTHY_PROBE = {
    "format": {"format_name": "mp3", "duration": "3600.0"},
    "streams": [{"codec_type": "audio", "codec_name": "mp3"}],
}


def _probe_payload(*, format_name="mp3", duration="30.0", audio_streams=1, error=None):
    if error is not None:
        return {"errors": [error]}
    streams = [{"codec_type": "audio", "codec_name": "aac"} for _ in range(audio_streams)]
    return {"format": {"format_name": format_name, "duration": duration}, "streams": streams}


@pytest.fixture(autouse=True)
def _patch_tools(monkeypatch):
    monkeypatch.setattr(ahs, "ffprobe_available", lambda: True)
    monkeypatch.setattr(ahs, "ffmpeg_available", lambda: True)
    monkeypatch.setattr(ahs, "has_leading_zero_padding", lambda _path: False)


def test_check_audio_file_healthy_is_ok(tmp_path, monkeypatch):
    path = tmp_path / "book.mp3"
    path.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: HEALTHY_PROBE)

    result = ahs.check_audio_file(str(path))
    assert result.status == "ok"
    assert result.duration == 3600.0
    assert result.codec == "mp3"
    assert result.issues == []


def test_check_audio_file_zero_padding_is_degraded(tmp_path, monkeypatch):
    path = tmp_path / "padded.mp3"
    path.write_bytes(b"\x00" * 4096 + b"ID3")
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: HEALTHY_PROBE)
    monkeypatch.setattr(ahs, "has_leading_zero_padding", lambda _p: True)

    result = ahs.check_audio_file(str(path))
    assert result.status == "degraded"
    assert "leading_zero_padding" in result.issues


def test_check_audio_file_unreadable_container(tmp_path, monkeypatch):
    path = tmp_path / "broken.m4b"
    path.write_bytes(b"garbage")
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: {"errors": ["Invalid data found"]})

    result = ahs.check_audio_file(str(path))
    assert result.status == "unreadable"
    assert "container_unreadable" in result.issues
    assert result.error_sample == "Invalid data found"


def test_check_audio_file_no_audio_stream_is_corrupt(tmp_path, monkeypatch):
    path = tmp_path / "video.m4a"
    path.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: _probe_payload(audio_streams=0))

    result = ahs.check_audio_file(str(path))
    assert result.status == "corrupt"
    assert "no_audio_stream" in result.issues


def test_check_audio_file_invalid_duration_is_corrupt(tmp_path, monkeypatch):
    path = tmp_path / "no-duration.mp3"
    path.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: _probe_payload(duration="N/A"))

    result = ahs.check_audio_file(str(path))
    assert result.status == "corrupt"
    assert "invalid_duration" in result.issues


def test_check_audio_file_probe_unavailable_is_unreadable(tmp_path, monkeypatch):
    path = tmp_path / "noprobe.mp3"
    path.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: None)

    result = ahs.check_audio_file(str(path))
    assert result.status == "unreadable"
    assert "probe_unavailable" in result.issues


def test_check_audio_file_missing_file(tmp_path):
    result = ahs.check_audio_file(str(tmp_path / "missing.mp3"))
    assert result.status == "unreadable"
    assert "file_missing" in result.issues


def test_check_audio_file_full_decode_counts_errors(tmp_path, monkeypatch):
    path = tmp_path / "damaged.mp3"
    path.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: HEALTHY_PROBE)
    monkeypatch.setattr(
        ahs,
        "_decode_sweep",
        lambda _p: {"error_count": 3, "error_sample": "bad header", "skipped": False},
    )

    result = ahs.check_audio_file(str(path), full_decode=True)
    assert result.status == "corrupt"
    assert result.error_count == 3
    assert "decode_errors" in result.issues


def test_check_audio_file_full_decode_clean(tmp_path, monkeypatch):
    path = tmp_path / "clean.mp3"
    path.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: HEALTHY_PROBE)
    monkeypatch.setattr(
        ahs,
        "_decode_sweep",
        lambda _p: {"error_count": 0, "error_sample": None, "skipped": False},
    )

    result = ahs.check_audio_file(str(path), full_decode=True)
    assert result.status == "ok"
    assert result.error_count == 0


def test_worst_status_prioritizes_severity():
    assert ahs.worst_status(["ok", "degraded", "corrupt"]) == "corrupt"
    assert ahs.worst_status(["ok", "ok"]) == "ok"
    assert ahs.worst_status([]) == "unchecked"


def test_build_repair_writes_cached_copy(tmp_path, monkeypatch):
    source = tmp_path / "src.mp3"
    source.write_bytes(b"ID3" + b"\x00" * 2048)
    repair_dir = tmp_path / "repair"

    calls = []

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        out_path = cmd[-1]
        open(out_path, "wb").write(b"ID3" * 100 + b"\xff\xfb")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(ahs.subprocess, "run", fake_run)
    monkeypatch.setattr(ahs, "REPAIR_DIR", repair_dir)

    repaired = ahs.build_repair(str(source))
    assert repaired is not None
    assert os.path.isfile(repaired)
    assert repaired.endswith(".mp3")
    assert source.read_bytes() == b"ID3" + b"\x00" * 2048

    again = ahs.build_repair(str(source))
    assert again == repaired
    assert len(calls) == 1


def test_build_repair_failure_returns_none_and_keeps_source(tmp_path, monkeypatch):
    source = tmp_path / "src.mp3"
    source.write_bytes(b"ID3")
    monkeypatch.setattr(
        ahs.subprocess,
        "run",
        lambda *_a, **_k: subprocess.CompletedProcess([], 1, "", "boom"),
    )
    monkeypatch.setattr(ahs, "REPAIR_DIR", tmp_path / "repair")

    assert ahs.build_repair(str(source)) is None
    assert source.read_bytes() == b"ID3"


def test_resolve_repair_path_healthy_returns_path(tmp_path, monkeypatch):
    path = tmp_path / "good.mp3"
    path.write_bytes(b"x" * 1024)
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: HEALTHY_PROBE)
    assert ahs.resolve_repair_path(str(path)) == str(path)


def test_resolve_repair_path_degraded_builds_repair(tmp_path, monkeypatch):
    path = tmp_path / "padded.mp3"
    path.write_bytes(b"\x00" * 4096 + b"ID3")
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: HEALTHY_PROBE)
    monkeypatch.setattr(ahs, "has_leading_zero_padding", lambda _p: True)
    monkeypatch.setattr(
        ahs,
        "build_repair",
        lambda _p: str(tmp_path / "repaired.mp3"),
    )
    assert ahs.resolve_repair_path(str(path)) == str(tmp_path / "repaired.mp3")


def test_resolve_repair_path_unreadable_returns_none(tmp_path, monkeypatch):
    path = tmp_path / "broken.m4b"
    path.write_bytes(b"garbage")
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: {"errors": ["Invalid data"]})
    monkeypatch.setattr(ahs, "build_repair", lambda _p: str(tmp_path / "repaired.mp3"))
    assert ahs.resolve_repair_path(str(path)) is None


def test_check_book_aggregates_across_tracks(tmp_path, monkeypatch):
    first = tmp_path / "01.mp3"
    second = tmp_path / "02.mp3"
    first.write_bytes(b"a")
    second.write_bytes(b"b")
    monkeypatch.setattr(ahs, "probe_audio", lambda _p: _probe_payload(duration="120.0"))

    book = SimpleNamespace(
        file_path=str(first),
        extra_metadata={"audio_files": [str(first), str(second)]},
    )
    health = ahs.check_book(book)
    assert health["status"] == "ok"
    assert len(health["files"]) == 2


@pytest.mark.asyncio
async def test_parse_book_file_records_audio_health(tmp_path, monkeypatch):
    source = tmp_path / "Author" / "Book"
    source.mkdir(parents=True)
    track = source / "01.mp3"
    track.write_bytes(b"ID3" + b"\xff" * 512)

    monkeypatch.setattr(
        scanner_service,
        "build_health_dict",
        lambda *_a, **_k: {"status": "degraded", "files": [], "checked_at": "now"},
    )

    metadata = await scanner_service.parse_book_file(
        str(track), BookFormat.mp3, str(tmp_path), [str(track)]
    )
    assert metadata["audio_health"]["status"] == "degraded"


def test_build_extra_metadata_keeps_audio_health():
    metadata = {"title": "T", "audio_health": {"status": "ok"}, "file_format": "mp3"}
    extra = scanner_service.build_extra_metadata(metadata)
    assert extra["audio_health"]["status"] == "ok"


async def _make_audio_book(db_session, test_user, tmp_path, name="Health Book", fmt=BookFormat.mp3, health=None):
    track = tmp_path / f"{name}.mp3"
    track.write_bytes(b"ID3" + b"\xff" * 512)
    library = Library(
        name=f"Lib {name}",
        path=str(tmp_path),
        type=LibraryType.audiobook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)
    extra = {"audio_files": [str(track)]}
    if health is not None:
        extra["audio_health"] = health
    book = Book(
        library_id=library.id,
        title=name,
        author="Author",
        file_path=str(track),
        file_format=fmt,
        file_size=track.stat().st_size,
        file_hash=f"hash-{name}",
        extra_metadata=extra,
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)
    return book, track


@pytest.mark.asyncio
async def test_get_book_audio_health_endpoint(client, db_session, test_user, tmp_path):
    book, _ = await _make_audio_book(
        db_session, test_user, tmp_path, health={"status": "corrupt", "files": [], "checked_at": "now"}
    )
    response = await client.get(f"/books/{book.id}/audio-health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["book_id"] == str(book.id)
    assert payload["health"]["status"] == "corrupt"


@pytest.mark.asyncio
async def test_scan_library_audio_health_endpoint(client, db_session, test_user, tmp_path, monkeypatch):
    book, _ = await _make_audio_book(db_session, test_user, tmp_path)
    monkeypatch.setattr(
        ah_api,
        "check_book",
        lambda _book, full_decode=False: {"status": "degraded", "files": [], "checked_at": "now"},
    )

    response = await client.post(f"/libraries/{book.library_id}/audio-health/scan")
    assert response.status_code == 200
    payload = response.json()
    assert payload["audited_books"] == 1
    assert payload["counts"]["degraded"] == 1


@pytest.mark.asyncio
async def test_scan_library_audio_health_requires_admin(client, db_session, test_user, tmp_path, monkeypatch):
    book, _ = await _make_audio_book(db_session, test_user, tmp_path)
    from app.models.user import User

    user = await db_session.get(User, test_user.id)
    user.is_admin = False
    await db_session.commit()

    monkeypatch.setattr(
        ah_api,
        "check_book",
        lambda _book, full_decode=False: {"status": "ok", "files": [], "checked_at": "now"},
    )

    response = await client.post(f"/libraries/{book.library_id}/audio-health/scan")
    assert response.status_code == 403


@pytest.mark.asyncio
async def test_list_audio_health_books_filters_to_audiobooks(client, db_session, test_user, tmp_path):
    audio_book, _ = await _make_audio_book(
        db_session, test_user, tmp_path, name="Audible", health={"status": "degraded"}
    )
    library = audio_book.library_id

    ebook_path = tmp_path / "printed.epub"
    ebook_path.write_bytes(b"epub")
    ebook = Book(
        library_id=library,
        title="Printed",
        author="B",
        file_path=str(ebook_path),
        file_format=BookFormat.epub,
        file_size=0,
        file_hash="e-hash",
    )
    db_session.add(ebook)
    await db_session.commit()

    response = await client.get("/audio-health/books", params={"status": "degraded"})
    assert response.status_code == 200
    payload = response.json()
    assert payload["total"] == 1
    assert payload["items"][0]["book_id"] == str(audio_book.id)
    assert payload["items"][0]["health"]["status"] == "degraded"


@pytest.mark.asyncio
async def test_repair_book_audio_endpoint(client, db_session, test_user, tmp_path, monkeypatch):
    book, track = await _make_audio_book(db_session, test_user, tmp_path)
    repaired = tmp_path / "repaired.mp3"
    repaired.write_bytes(b"ID3")
    monkeypatch.setattr(ah_api, "resolve_repair_path", lambda _p: str(repaired))

    async def _fake_rebuild(_book):
        return "/data/hls/x/master.m3u8"

    monkeypatch.setattr(ah_api, "rebuild_hls_playlist", _fake_rebuild)
    monkeypatch.setattr(
        ah_api,
        "check_book",
        lambda _book, full_decode=False: {"status": "ok", "files": [], "checked_at": "now"},
    )

    response = await client.post(f"/books/{book.id}/audio-health/repair")
    assert response.status_code == 200
    payload = response.json()
    assert payload["tracks"][0]["repair_path"] == str(repaired)
    assert payload["hls_playlist"] == "/data/hls/x/master.m3u8"
    assert payload["health"]["repair"]["repaired_at"]