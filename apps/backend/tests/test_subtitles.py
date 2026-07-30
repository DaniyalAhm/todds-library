from __future__ import annotations

import json
import uuid

import pytest

from app.models.book import Book, BookFormat
from app.models.chapter import Chapter
from app.models.library import Library, LibraryType


@pytest.mark.asyncio
async def test_get_chapter_subtitles_returns_json(client, db_session, test_user, tmp_path):
    audio_path = tmp_path / "book.mp3"
    audio_path.write_bytes(b"audio")

    library = Library(
        id=uuid.uuid4(),
        name="Audio Library",
        path=str(tmp_path),
        type=LibraryType.audiobook,
        user_id=test_user.id,
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

    subtitles_dir = audio_path.parent / "subtitles" / str(book.id)
    subtitles_dir.mkdir(parents=True)
    subtitle_body = {
        "language": "en",
        "text": "Hello world",
        "cues": [
            {
                "start": 0,
                "end": 2,
                "text": "Hello world",
                "words": [
                    {"start": 0, "end": 1, "text": "Hello"},
                    {"start": 1, "end": 2, "text": "world"},
                ],
            }
        ],
    }
    (subtitles_dir / "chapter_0001.json").write_text(json.dumps(subtitle_body))

    response = await client.get(
        f"/books/{book.id}/chapters/{chapter.id}/subtitles?format=json"
    )

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/json")
    assert response.json()["cues"][0]["words"][0]["text"] == "Hello"
