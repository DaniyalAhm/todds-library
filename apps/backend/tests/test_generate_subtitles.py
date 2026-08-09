from __future__ import annotations

import uuid

import pytest
from sqlalchemy import select

from app.models.book import Book, BookFormat
from app.models.chapter import Chapter
from app.models.generation_log import GenerationLog
from app.models.library import Library, LibraryType
from app.models.subtitle import SubtitleMetadata
from app.models.user import User
from app.services.asr_service import SubtitleResult
from app.services.auth_service import create_user_jwt


async def _create_audiobook(db_session, owner, tmp_path):
    audio_path = tmp_path / "book.mp3"
    audio_path.write_bytes(b"audio")

    library = Library(
        id=uuid.uuid4(),
        name="Audio Library",
        path=str(tmp_path),
        type=LibraryType.audiobook,
        user_id=owner.id,
    )
    db_session.add(library)
    await db_session.commit()

    book = Book(
        id=uuid.uuid4(),
        library_id=library.id,
        title="Subtitle Book",
        file_path=str(audio_path),
        file_format=BookFormat.mp3,
        file_size=1,
        file_hash="hash",
    )
    db_session.add(book)
    await db_session.commit()

    chapter = Chapter(
        id=uuid.uuid4(),
        book_id=book.id,
        index=1,
        title="Chapter 1",
        start_position=0,
    )
    db_session.add(chapter)
    await db_session.commit()

    return book, chapter, audio_path


async def _add_existing_subtitle(db_session, book, chapter):
    db_session.add(
        SubtitleMetadata(
            chapter_id=chapter.id,
            book_id=book.id,
            language="en",
            model_id="base",
            status="completed",
            json_path="chapter_0001.json",
            srt_path="chapter_0001.srt",
            vtt_path="chapter_0001.vtt",
            cue_count=1,
            word_count=2,
            duration_sec=10.0,
        )
    )
    await db_session.commit()


def _fake_transcribe(*_args, **_kwargs) -> SubtitleResult:
    return SubtitleResult(
        srt_path="chapter_0001.srt",
        vtt_path="chapter_0001.vtt",
        json_path="chapter_0001.json",
        language="en",
        model_id="base",
        cue_count=2,
        word_count=3,
        duration_sec=10.0,
    )


@pytest.mark.asyncio
async def test_subtitles_already_exist_returns_conflict(client, db_session, test_user, tmp_path):
    book, chapter, _ = await _create_audiobook(db_session, test_user, tmp_path)
    await _add_existing_subtitle(db_session, book, chapter)

    response = await client.post(
        f"/books/{book.id}/chapters/{chapter.id}/generate/subtitles"
    )

    assert response.status_code == 409


@pytest.mark.asyncio
async def test_overwrite_subtitles_requires_admin(client, db_session, test_user, tmp_path):
    non_admin = User(
        id=uuid.uuid4(),
        username="regular",
        email="regular@example.com",
        authentik_sub="sub-regular",
        is_admin=False,
    )
    db_session.add(non_admin)
    await db_session.commit()

    book, chapter, _ = await _create_audiobook(db_session, non_admin, tmp_path)
    await _add_existing_subtitle(db_session, book, chapter)
    token = create_user_jwt(non_admin)

    response = await client.post(
        f"/books/{book.id}/chapters/{chapter.id}/generate/subtitles?overwrite=true",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403
    assert "Admin" in response.json()["detail"]


@pytest.mark.asyncio
async def test_overwrite_subtitles_as_admin_retranscribes(client, db_session, test_user, tmp_path, monkeypatch):
    book, chapter, _ = await _create_audiobook(db_session, test_user, tmp_path)
    await _add_existing_subtitle(db_session, book, chapter)

    called: dict[str, bool] = {}

    def fake_transcribe(*_args, **_kwargs):
        called["transcribed"] = True
        return _fake_transcribe()

    monkeypatch.setattr("app.api.generate.transcribe_chapter", fake_transcribe)

    response = await client.post(
        f"/books/{book.id}/chapters/{chapter.id}/generate/subtitles?overwrite=true"
    )

    assert response.status_code == 200
    assert called["transcribed"] is True


@pytest.mark.asyncio
async def test_book_overwrite_subtitles_requires_admin(client, db_session, test_user, tmp_path):
    non_admin = User(
        id=uuid.uuid4(),
        username="regular",
        email="regular@example.com",
        authentik_sub="sub-regular",
        is_admin=False,
    )
    db_session.add(non_admin)
    await db_session.commit()

    book, chapter, _ = await _create_audiobook(db_session, non_admin, tmp_path)
    await _add_existing_subtitle(db_session, book, chapter)
    token = create_user_jwt(non_admin)

    response = await client.post(
        f"/books/{book.id}/generate/subtitles",
        json={"overwrite": True},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 403
    assert "Admin" in response.json()["detail"]


@pytest.mark.asyncio
async def test_book_overwrite_subtitles_as_admin_retranscribes_all(client, db_session, test_user, tmp_path, monkeypatch):
    book, chapter, _ = await _create_audiobook(db_session, test_user, tmp_path)

    chapter2 = Chapter(
        id=uuid.uuid4(),
        book_id=book.id,
        index=2,
        title="Chapter 2",
        start_position=100,
    )
    db_session.add(chapter2)
    await db_session.commit()

    await _add_existing_subtitle(db_session, book, chapter)
    await _add_existing_subtitle(db_session, book, chapter2)

    transcribed: list[int] = []

    def fake_transcribe(audio_path, subtitles_dir, index, *args, **kwargs):
        transcribed.append(index)
        return _fake_transcribe()

    monkeypatch.setattr("app.api.generate.transcribe_chapter", fake_transcribe)

    response = await client.post(
        f"/books/{book.id}/generate/subtitles",
        json={"overwrite": True},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "completed"
    assert [r["status"] for r in body["results"]] == ["completed", "completed"]
    assert set(transcribed) == {1, 2}


@pytest.mark.asyncio
async def test_book_generation_skips_existing_without_overwrite(client, db_session, test_user, tmp_path, monkeypatch):
    book, chapter, _ = await _create_audiobook(db_session, test_user, tmp_path)
    await _add_existing_subtitle(db_session, book, chapter)

    transcribed: list[int] = []
    monkeypatch.setattr(
        "app.api.generate.transcribe_chapter",
        lambda *args, **kwargs: transcribed.append(1) or _fake_transcribe(),
    )

    response = await client.post(
        f"/books/{book.id}/generate/subtitles",
        json={},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["results"][0]["status"] == "skipped"
    assert transcribed == []


@pytest.mark.asyncio
async def test_book_generation_marks_missing_audio_failed(client, db_session, test_user, tmp_path):
    book, chapter, _ = await _create_audiobook(db_session, test_user, tmp_path)
    book.file_path = str(tmp_path / "missing.mp3")
    await db_session.commit()

    response = await client.post(
        f"/books/{book.id}/generate/subtitles",
        json={},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["results"][0]["status"] == "failed"
    assert "Audio file not found" in body["results"][0]["error"]


@pytest.mark.asyncio
async def test_overwrite_clears_chapter_partials(client, db_session, test_user, tmp_path, monkeypatch):
    book, chapter, audio_path = await _create_audiobook(db_session, test_user, tmp_path)
    await _add_existing_subtitle(db_session, book, chapter)

    subtitles_dir = audio_path.parent / "subtitles" / str(book.id)
    partial_dir = subtitles_dir / ".partials" / "chapter_0001"
    partial_dir.mkdir(parents=True)
    (partial_dir / "chunk_000001.json").write_text("{}")

    monkeypatch.setattr("app.api.generate.transcribe_chapter", _fake_transcribe)

    response = await client.post(
        f"/books/{book.id}/chapters/{chapter.id}/generate/subtitles?overwrite=true"
    )

    assert response.status_code == 200
    assert not partial_dir.exists()


@pytest.mark.asyncio
async def test_overwrite_records_generation_log(client, db_session, test_user, tmp_path, monkeypatch):
    book, chapter, _ = await _create_audiobook(db_session, test_user, tmp_path)
    await _add_existing_subtitle(db_session, book, chapter)

    monkeypatch.setattr("app.api.generate.transcribe_chapter", _fake_transcribe)

    response = await client.post(
        f"/books/{book.id}/chapters/{chapter.id}/generate/subtitles?overwrite=true"
    )

    assert response.status_code == 200

    result = await db_session.execute(
        select(GenerationLog).where(
            GenerationLog.chapter_id == chapter.id,
            GenerationLog.status == "completed",
        )
    )
    log = result.scalar_one_or_none()
    assert log is not None
    assert "cues" in (log.message or "")

    result = await db_session.execute(
        select(GenerationLog).where(
            GenerationLog.chapter_id == chapter.id,
            GenerationLog.status == "started",
            GenerationLog.message.contains("overwriting"),
        )
    )
    started = result.scalar_one_or_none()
    assert started is not None
