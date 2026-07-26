from __future__ import annotations

import uuid

import pytest

from app.config import settings
from app.metadata.rreading_glasses import RReadingGlassesProvider
from app.models.book import Book, BookFormat
from app.models.library import Library, LibraryType
from app.services.metadata_service import apply_metadata_to_book, cache_metadata, enrich_book_metadata, lookup_metadata


@pytest.mark.asyncio
async def test_apply_metadata_persists_cover_data(db_session, test_user, tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "covers_dir", str(tmp_path / "covers"))

    library = Library(
        id=uuid.uuid4(),
        name="Library",
        path=str(tmp_path),
        type=LibraryType.ebook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()

    book = Book(
        id=uuid.uuid4(),
        library_id=library.id,
        title="Old Title",
        file_path=str(tmp_path / "book.epub"),
        file_format=BookFormat.epub,
        file_size=1,
        file_hash="hash",
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    updated = await apply_metadata_to_book(
        db_session,
        book,
        {"title": "New Title", "cover_data": b"cover-bytes"},
        overwrite=True,
    )

    assert updated.title == "New Title"
    assert updated.cover_path is not None
    assert (tmp_path / "covers" / "hash.jpg").read_bytes() == b"cover-bytes"


@pytest.mark.asyncio
async def test_apply_metadata_preserves_numeric_field_types(db_session, test_user, tmp_path):
    library = Library(
        id=uuid.uuid4(),
        name="Library",
        path=str(tmp_path),
        type=LibraryType.ebook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()

    book = Book(
        id=uuid.uuid4(),
        library_id=library.id,
        title="Typed Book",
        file_path=str(tmp_path / "book.epub"),
        file_format=BookFormat.epub,
        file_size=1,
        file_hash="hash",
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    updated = await apply_metadata_to_book(
        db_session,
        book,
        {"page_count": "321", "series_index": "2.5", "duration": "42.25"},
        overwrite=True,
    )

    assert updated.page_count == 321
    assert isinstance(updated.page_count, int)
    assert updated.series_index == 2.5
    assert isinstance(updated.series_index, float)
    assert updated.duration == 42.25
    assert isinstance(updated.duration, float)


@pytest.mark.asyncio
async def test_lookup_metadata_returns_saved_cache_without_fetching(db_session, test_user, tmp_path, monkeypatch):
    library = Library(
        id=uuid.uuid4(),
        name="Library",
        path=str(tmp_path),
        type=LibraryType.ebook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()

    book = Book(
        id=uuid.uuid4(),
        library_id=library.id,
        title="Cached Title",
        file_path=str(tmp_path / "book.epub"),
        file_format=BookFormat.epub,
        file_size=1,
        file_hash="hash",
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    await cache_metadata(
        db_session,
        book.id,
        "openlibrary",
        {"title": "Saved Title", "author": "Saved Author"},
    )

    class FailingProvider:
        name = "failing"

        async def fetch(self, **_kwargs):
            raise AssertionError("provider should not be called when cache exists")

    monkeypatch.setattr("app.services.metadata_service._providers", lambda: [FailingProvider()])

    results = await lookup_metadata(db_session, book_id=book.id, title=book.title)

    assert results == [
        {
            "title": "Saved Title",
            "author": "Saved Author",
            "source": "openlibrary",
            "cached": True,
            "last_fetched": results[0]["last_fetched"],
            "has_cover": False,
        }
    ]


@pytest.mark.asyncio
async def test_enrich_book_metadata_applies_cached_metadata_to_missing_fields(
    db_session, test_user, tmp_path, monkeypatch
):
    monkeypatch.setattr(settings, "covers_dir", str(tmp_path / "covers"))

    library = Library(
        id=uuid.uuid4(),
        name="Library",
        path=str(tmp_path),
        type=LibraryType.ebook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()

    book = Book(
        id=uuid.uuid4(),
        library_id=library.id,
        title="Scanned Title",
        file_path=str(tmp_path / "book.epub"),
        file_format=BookFormat.epub,
        file_size=1,
        file_hash="hash",
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    await cache_metadata(
        db_session,
        book.id,
        "openlibrary",
        {
            "title": "Fetched Title",
            "author": "Fetched Author",
            "page_count": 123,
            "cover_data": b"cover-bytes",
        },
    )

    class OpenLibraryOnlyProvider:
        name = "openlibrary"

        async def fetch(self, **_kwargs):
            raise AssertionError("cached provider data should be used")

    monkeypatch.setattr("app.services.metadata_service._providers", lambda: [OpenLibraryOnlyProvider()])

    updated = await enrich_book_metadata(db_session, book)

    assert updated.title == "Scanned Title"
    assert updated.author == "Fetched Author"
    assert updated.page_count == 123
    assert updated.cover_path == str(tmp_path / "covers" / f"{book.id}-openlibrary.jpg")
    assert (tmp_path / "covers" / f"{book.id}-openlibrary.jpg").read_bytes() == b"cover-bytes"


@pytest.mark.asyncio
async def test_enrich_book_metadata_refetches_when_cached_cover_is_missing(
    db_session, test_user, tmp_path, monkeypatch
):
    monkeypatch.setattr(settings, "covers_dir", str(tmp_path / "covers"))

    library = Library(
        id=uuid.uuid4(),
        name="Library",
        path=str(tmp_path),
        type=LibraryType.ebook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()

    book = Book(
        id=uuid.uuid4(),
        library_id=library.id,
        title="Scanned Title",
        file_path=str(tmp_path / "book.epub"),
        file_format=BookFormat.epub,
        file_size=1,
        file_hash="hash",
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    await cache_metadata(
        db_session,
        book.id,
        "openlibrary",
        {"title": "Cached Title", "author": "Cached Author"},
    )

    fetch_calls = {"count": 0}

    class OpenLibraryOnlyProvider:
        name = "openlibrary"

        async def fetch(self, **_kwargs):
            fetch_calls["count"] += 1
            return {
                "title": "Fetched Title",
                "author": "Fetched Author",
                "cover_data": b"fresh-cover",
            }

    monkeypatch.setattr("app.services.metadata_service._providers", lambda: [OpenLibraryOnlyProvider()])

    updated = await enrich_book_metadata(db_session, book)

    assert fetch_calls["count"] == 1
    assert updated.title == "Scanned Title"
    assert updated.author == "Cached Author"
    assert updated.cover_path == str(tmp_path / "covers" / f"{book.id}-openlibrary.jpg")


@pytest.mark.asyncio
async def test_rreading_glasses_provider_parses_lookup_result(monkeypatch):
    class FakeResponse:
        def __init__(self, status_code: int, json_data: dict | list, content: bytes = b""):
            self.status_code = status_code
            self._json_data = json_data
            self.content = content

        def json(self):
            return self._json_data

    class FakeClient:
        def __init__(self, *args, **kwargs):
            self.calls = []

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return None

        async def get(self, url, params=None):
            self.calls.append((url, params))
            if url.startswith("http://rreading-glasses:8788"):
                raise AssertionError("local mirror should fall back to the public instance")
            if url.startswith("https://api.bookinfo.pro/search"):
                return FakeResponse(
                    200,
                    [{"workId": 3634639, "bookId": 44767458, "author": {"id": 58}}],
                )
            if url.startswith("https://api.bookinfo.pro/work/3634639"):
                return FakeResponse(
                    200,
                    {
                        "Title": "The Test Book",
                        "FullTitle": "The Test Book",
                        "ShortTitle": "The Test Book",
                        "ReleaseDate": "1965-06-01 07:00:00",
                        "ReleaseDateRaw": "1965-06-01",
                        "Authors": [{"ForeignId": 58, "Name": "Test Author"}],
                        "Series": [
                            {
                                "Title": "Test Series",
                                "LinkItems": [{"SeriesPosition": 3, "Primary": True}],
                            }
                        ],
                        "Books": [
                            {
                                "Title": "The Test Book",
                                "FullTitle": "The Test Book",
                                "ShortTitle": "The Test Book",
                                "Publisher": "Test Press",
                                "ReleaseDate": "2024-01-02",
                                "NumPages": 456,
                                "Isbn13": "9781234567890",
                                "Language": "eng",
                                "ImageUrl": "/covers/9876.jpg",
                            }
                        ],
                    },
                )
            if url.startswith("https://api.bookinfo.pro/covers/9876.jpg"):
                return FakeResponse(200, {}, b"cover-bytes")
            raise AssertionError(f"unexpected url {url}")

    monkeypatch.setattr("app.metadata.rreading_glasses.httpx.AsyncClient", FakeClient)
    monkeypatch.setattr(settings, "rreading_glasses_url", "http://rreading-glasses:8788")

    provider = RReadingGlassesProvider()
    result = await provider.fetch(title="The Test Book", author="Test Author")

    assert result == {
        "title": "The Test Book",
        "author": "Test Author",
        "description": "A detailed synopsis",
        "publisher": "Test Press",
        "published_date": "2024-01-02",
        "page_count": 456,
        "isbn": "9781234567890",
        "language": "en",
        "series": "Test Series",
        "series_index": 3.0,
        "cover_data": b"cover-bytes",
    }
