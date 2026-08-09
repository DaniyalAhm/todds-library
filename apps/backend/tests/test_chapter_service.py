from __future__ import annotations

import json
import uuid
from pathlib import Path

import pytest

from app.models.book import Book, BookFormat
from app.models.chapter import Chapter
from app.services import asr_service, chapter_service


def test_detect_chapters_splits_at_gap_threshold() -> None:
    segments = [
        {"start": 0.0, "end": 5.0, "text": "First chapter intro."},
        {"start": 5.2, "end": 10.0, "text": "Continuing first chapter."},
        {"start": 14.0, "end": 20.0, "text": "Second chapter begins here."},
    ]
    chapters = chapter_service.detect_chapters_from_segments(segments, gap_threshold_sec=3.0)

    assert len(chapters) == 2
    assert chapters[0]["index"] == 1
    assert chapters[0]["start_position"] == 0.0
    assert chapters[0]["end_position"] == 10.0
    assert chapters[0]["title"] == "First chapter intro."
    assert chapters[1]["index"] == 2
    assert chapters[1]["start_position"] == 14.0
    assert chapters[1]["end_position"] == 20.0
    assert chapters[1]["title"] == "Second chapter begins here."


def test_detect_chapters_keeps_single_chapter_with_small_gaps() -> None:
    segments = [
        {"start": 0.0, "end": 4.0, "text": "One."},
        {"start": 4.5, "end": 8.0, "text": "Two."},
        {"start": 8.5, "end": 12.0, "text": "Three."},
    ]
    chapters = chapter_service.detect_chapters_from_segments(segments, gap_threshold_sec=3.0)

    assert len(chapters) == 1
    assert chapters[0]["start_position"] == 0.0
    assert chapters[0]["end_position"] == 12.0


def test_detect_chapters_sorts_unordered_segments() -> None:
    segments = [
        {"start": 6.0, "end": 15.0, "text": "Later."},
        {"start": 0.0, "end": 5.0, "text": "Earlier."},
    ]
    chapters = chapter_service.detect_chapters_from_segments(segments)

    assert len(chapters) == 1
    assert chapters[0]["start_position"] == 0.0
    assert chapters[0]["end_position"] == 15.0


def test_detect_chapters_empty_segments() -> None:
    assert chapter_service.detect_chapters_from_segments([]) == []


def test_chapter_title_uses_first_full_sentence() -> None:
    assert (
        chapter_service._chapter_title("The morning sun rose over the hills. She opened her eyes.", 1)
        == "The morning sun rose over the hills."
    )


def test_chapter_title_falls_back_to_first_words() -> None:
    assert chapter_service._chapter_title("no punctuation at all here", 1) == "no punctuation at all here"


def test_chapter_title_empty_text() -> None:
    assert chapter_service._chapter_title("   ", 3) == "Chapter 3"


def test_chapter_title_truncates_long_sentences() -> None:
    long_text = "A" * 600 + ". Trailing text."
    title = chapter_service._chapter_title(long_text, 1, max_length=512)
    assert len(title) == 512


def test_detect_book_chapters_sync(monkeypatch) -> None:
    book = Book(
        id=uuid.uuid4(),
        library_id=uuid.uuid4(),
        title="Test Book",
        file_path="/tmp/book.m4b",
        file_format=BookFormat.m4b,
    )

    monkeypatch.setattr(chapter_service, "resolve_audio_source", lambda _book: "/tmp/book.m4b")
    monkeypatch.setattr(
        asr_service,
        "transcribe_full_source",
        lambda *_a, **_kw: asr_service.TranscriptionResult(
            text="hello world",
            language="en",
            segments=[
                {"start": 0.0, "end": 5.0, "text": " First.", "words": []},
                {"start": 9.0, "end": 12.0, "text": " Second.", "words": []},
            ],
        ),
    )

    result = chapter_service.detect_book_chapters_sync(book, gap_threshold_sec=3.0)

    assert result["source"] == "/tmp/book.m4b"
    assert result["duration"] == 12.0
    assert len(result["chapters"]) == 2
    assert result["chapters"][0]["start_position"] == 0.0
    assert result["chapters"][1]["start_position"] == 9.0


def test_detect_book_chapters_sync_rejects_multi_track(monkeypatch) -> None:
    book = Book(
        id=uuid.uuid4(),
        library_id=uuid.uuid4(),
        title="Test Book",
        file_path="/tmp/book.m4b",
        file_format=BookFormat.m4b,
        extra_metadata={"audio_files": ["/tmp/a.mp3", "/tmp/b.mp3"]},
    )

    with pytest.raises(chapter_service.ChapterDetectionError):
        chapter_service.detect_book_chapters_sync(book)


def _write_subtitle_json(path: str, cues: list[dict]) -> str:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(
        json.dumps({"language": "en", "text": "x", "cues": cues}),
        encoding="utf-8",
    )
    return path


def test_load_subtitle_segments_parses_cues(tmp_path) -> None:
    json_path = _write_subtitle_json(
        str(tmp_path / "chapter_0001.json"),
        [
            {"start": 0.0, "end": 5.0, "text": "First.", "words": []},
            {"start": 9.0, "end": 12.0, "text": "Second.", "words": []},
        ],
    )

    segments = chapter_service.load_subtitle_segments([(json_path, 2)])

    assert segments is not None
    assert segments == [
        {"start": 0.0, "end": 5.0, "text": "First."},
        {"start": 9.0, "end": 12.0, "text": "Second."},
    ]


def test_load_subtitle_segments_prefers_largest_cue_count(tmp_path) -> None:
    small = _write_subtitle_json(
        str(tmp_path / "small.json"),
        [{"start": 0.0, "end": 1.0, "text": "S.", "words": []}],
    )
    large = _write_subtitle_json(
        str(tmp_path / "large.json"),
        [
            {"start": 0.0, "end": 5.0, "text": "L1.", "words": []},
            {"start": 9.0, "end": 12.0, "text": "L2.", "words": []},
        ],
    )

    segments = chapter_service.load_subtitle_segments(
        [(small, 1), (large, 2)]
    )

    assert segments is not None
    assert [s["text"] for s in segments] == ["L1.", "L2."]


def test_load_subtitle_segments_missing_or_corrupt_returns_none(tmp_path) -> None:
    missing = str(tmp_path / "does-not-exist.json")
    corrupt = str(tmp_path / "corrupt.json")
    corrupt_path = Path(corrupt)
    corrupt_path.write_text("not json {", encoding="utf-8")

    assert chapter_service.load_subtitle_segments([(missing, 1), (corrupt, 1)]) is None


def test_detect_book_chapters_sync_recycles_subtitle_timestamps(tmp_path, monkeypatch) -> None:
    book = Book(
        id=uuid.uuid4(),
        library_id=uuid.uuid4(),
        title="Test Book",
        file_path="/tmp/book.m4b",
        file_format=BookFormat.m4b,
    )
    json_path = _write_subtitle_json(
        str(tmp_path / "chapter_0001.json"),
        [
            {"start": 0.0, "end": 5.0, "text": "First chapter.", "words": []},
            {"start": 5.2, "end": 10.0, "text": "Continuing.", "words": []},
            {"start": 14.0, "end": 20.0, "text": "Second chapter.", "words": []},
        ],
    )

    monkeypatch.setattr(chapter_service, "resolve_audio_source", lambda _book: "/tmp/book.m4b")
    called = {"transcribed": False}

    def _fail_transcription(*_args, **_kwargs):
        called["transcribed"] = True
        raise AssertionError("transcription should be skipped when subtitles exist")

    monkeypatch.setattr(asr_service, "transcribe_full_source", _fail_transcription)

    result = chapter_service.detect_book_chapters_sync(
        book,
        gap_threshold_sec=3.0,
        subtitle_candidates=[(json_path, 3)],
    )

    assert called["transcribed"] is False
    assert result["source"] == "/tmp/book.m4b"
    assert result["duration"] == 20.0
    assert len(result["chapters"]) == 2
    assert result["chapters"][0]["start_position"] == 0.0
    assert result["chapters"][1]["start_position"] == 14.0


def test_detect_book_chapters_sync_falls_back_when_subtitles_unusable(monkeypatch) -> None:
    book = Book(
        id=uuid.uuid4(),
        library_id=uuid.uuid4(),
        title="Test Book",
        file_path="/tmp/book.m4b",
        file_format=BookFormat.m4b,
    )

    monkeypatch.setattr(chapter_service, "resolve_audio_source", lambda _book: "/tmp/book.m4b")
    monkeypatch.setattr(
        asr_service,
        "transcribe_full_source",
        lambda *_a, **_kw: asr_service.TranscriptionResult(
            text="hello world",
            language="en",
            segments=[
                {"start": 0.0, "end": 5.0, "text": " First.", "words": []},
                {"start": 9.0, "end": 12.0, "text": " Second.", "words": []},
            ],
        ),
    )

    result = chapter_service.detect_book_chapters_sync(
        book,
        gap_threshold_sec=3.0,
        subtitle_candidates=[("/tmp/missing-subtitles.json", 5)],
    )

    assert result["source"] == "/tmp/book.m4b"
    assert result["duration"] == 12.0
    assert len(result["chapters"]) == 2
    assert result["chapters"][1]["start_position"] == 9.0


@pytest.mark.asyncio
async def test_apply_chapters_to_book_requires_overwrite(db_session, test_library) -> None:
    book = Book(
        id=uuid.uuid4(),
        library_id=test_library.id,
        title="Audiobook",
        file_path="/tmp/book.m4b",
        file_format=BookFormat.m4b,
        duration=0.0,
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    chapters = [
        {"index": 1, "title": "First.", "start_position": 0.0, "end_position": 10.0},
        {"index": 2, "title": "Second.", "start_position": 15.0, "end_position": 30.0},
    ]
    await chapter_service.apply_chapters_to_book(db_session, book, chapters, overwrite=False, duration=30.0)

    assert len(book.chapters) == 2
    assert book.duration == 30.0
    first = book.chapters[0]
    assert first.title == "First."
    assert first.start_position == 0.0
    assert first.end_position == 10.0

    with pytest.raises(chapter_service.ChapterDetectionError):
        await chapter_service.apply_chapters_to_book(db_session, book, chapters, overwrite=False)

    await chapter_service.apply_chapters_to_book(db_session, book, chapters, overwrite=True)
    assert len(book.chapters) == 2


@pytest.mark.asyncio
async def test_apply_chapters_to_book_keeps_existing_duration(db_session, test_library) -> None:
    book = Book(
        id=uuid.uuid4(),
        library_id=test_library.id,
        title="Audiobook",
        file_path="/tmp/book.m4b",
        file_format=BookFormat.m4b,
        duration=3600.0,
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    await chapter_service.apply_chapters_to_book(
        db_session,
        book,
        [{"index": 1, "title": "First.", "start_position": 0.0, "end_position": 10.0}],
        overwrite=False,
        duration=300.0,
    )

    assert book.duration == 3600.0
