from __future__ import annotations

import hashlib

import pytest
from sqlalchemy import select

from app.config import settings
from app.models.book import Book
from app.models.book import BookFormat
from app.models.library import Library, LibraryType
from app.services.scanner_service import add_book_to_db, parse_book_file, scan_library


@pytest.mark.asyncio
async def test_admin_can_list_available_library_directories(client, monkeypatch, tmp_path):
    books = tmp_path / "books"
    books.mkdir()
    (books / "Ebooks").mkdir()
    (books / "Audiobooks").mkdir()
    (books / "loose.epub").write_text("not a directory")
    monkeypatch.setattr(settings, "books_dir", str(books))

    response = await client.get("/libraries/directories")

    assert response.status_code == 200
    data = response.json()
    assert data["root"] == str(books)
    assert data["current"] == str(books)
    assert data["parent"] is None
    assert data["items"] == [
        {"name": "Audiobooks", "path": str(books / "Audiobooks"), "has_children": False},
        {"name": "Ebooks", "path": str(books / "Ebooks"), "has_children": False},
    ]


@pytest.mark.asyncio
async def test_admin_can_browse_nested_library_directories(client, monkeypatch, tmp_path):
    books = tmp_path / "books"
    nested = books / "Audiobooks"
    nested.mkdir(parents=True)
    (nested / "Series").mkdir()
    monkeypatch.setattr(settings, "books_dir", str(books))

    response = await client.get("/libraries/directories", params={"path": str(nested)})

    assert response.status_code == 200
    data = response.json()
    assert data["root"] == str(books)
    assert data["current"] == str(nested)
    assert data["parent"] == str(books)
    assert data["items"] == [
        {"name": "Series", "path": str(nested / "Series"), "has_children": False},
    ]


@pytest.mark.asyncio
async def test_admin_cannot_browse_outside_library_root(client, monkeypatch, tmp_path):
    books = tmp_path / "books"
    outside = tmp_path / "outside"
    books.mkdir()
    outside.mkdir()
    monkeypatch.setattr(settings, "books_dir", str(books))

    response = await client.get("/libraries/directories", params={"path": str(outside)})

    assert response.status_code == 422
    assert response.json() == {"detail": "Directory must be inside the configured library root"}


@pytest.mark.asyncio
async def test_admin_can_create_library_from_directory(client, tmp_path):
    library_path = tmp_path / "library"
    library_path.mkdir()

    response = await client.post(
        "/libraries",
        json={"name": "Library", "path": str(library_path), "type": "mixed"},
    )

    assert response.status_code == 201
    data = response.json()
    assert data["name"] == "Library"
    assert data["path"] == str(library_path.resolve())
    assert data["type"] == "mixed"


@pytest.mark.asyncio
async def test_library_create_rejects_missing_directory(client, tmp_path):
    response = await client.post(
        "/libraries",
        json={"name": "Missing", "path": str(tmp_path / "missing"), "type": "mixed"},
    )

    assert response.status_code == 422
    assert response.json() == {"detail": "Library path must be an existing directory"}


@pytest.mark.asyncio
async def test_library_create_rejects_duplicate_path(client, tmp_path):
    library_path = tmp_path / "library"
    library_path.mkdir()

    first = await client.post(
        "/libraries",
        json={"name": "Library", "path": str(library_path), "type": "mixed"},
    )
    assert first.status_code == 201

    duplicate = await client.post(
        "/libraries",
        json={"name": "Duplicate", "path": str(library_path), "type": "mixed"},
    )
    assert duplicate.status_code == 422
    assert duplicate.json() == {"detail": "Library path has already been added"}


@pytest.mark.asyncio
async def test_non_admin_cannot_create_library(client, db_session, test_user, tmp_path):
    test_user.is_admin = False
    await db_session.commit()

    response = await client.post(
        "/libraries",
        json={"name": "Library", "path": str(tmp_path), "type": "mixed"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Admin access required"}


@pytest.mark.asyncio
async def test_scanner_filters_files_by_library_type(db_session, test_user, tmp_path, monkeypatch):
    media = tmp_path / "media"
    media.mkdir()
    (media / "book.epub").write_text("book")
    (media / "audio.mp3").write_text("audio")

    library = Library(
        name="Ebooks",
        path=str(media),
        type=LibraryType.ebook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)

    async def fake_hash(path: str) -> str:
        return hashlib.sha256(path.encode("utf-8")).hexdigest()

    async def fake_parse(
        path: str,
        fmt: BookFormat,
        _library_path: str | None = None,
        _audio_files: list[str] | None = None,
    ) -> dict:
        return {
            "title": path,
            "file_path": path,
            "file_format": fmt.value,
            "file_size": 1,
            "file_hash": path,
        }

    monkeypatch.setattr("app.services.scanner_service.get_file_hash", fake_hash)
    monkeypatch.setattr("app.services.scanner_service.parse_book_file", fake_parse)
    monkeypatch.setattr("app.services.scanner_service.index_book_in_meili", lambda *_args, **_kwargs: None)

    result = await scan_library(db_session, object(), library.id)

    assert result["new"] == 1


@pytest.mark.asyncio
async def test_scanner_uses_author_title_folder_layout(tmp_path, monkeypatch):
    library_root = tmp_path / "media"
    book_file = library_root / "book" / "Octavia Butler" / "Kindred" / "track01.mp3"
    book_file.parent.mkdir(parents=True)
    book_file.write_bytes(b"audio")

    async def fake_hash(path: str) -> str:
        return hashlib.sha256(path.encode("utf-8")).hexdigest()

    monkeypatch.setattr("app.services.scanner_service.get_file_hash", fake_hash)
    monkeypatch.setattr(
        "app.services.scanner_service.parse_audio",
        lambda _path: {"title": None, "author": None, "duration": 60, "chapters": []},
    )

    metadata = await parse_book_file(str(book_file), BookFormat.mp3, str(library_root))

    assert metadata["author"] == "Octavia Butler"
    assert metadata["title"] == "Kindred"
    assert metadata["duration"] == 60


@pytest.mark.asyncio
async def test_scanner_uses_author_root_folder_layout(tmp_path, monkeypatch):
    library_root = tmp_path / "books" / "Andy Weir"
    book_file = library_root / "Project Hail Mary" / "Chapters" / "01 - Track.mp3"
    book_file.parent.mkdir(parents=True)
    book_file.write_bytes(b"audio")

    async def fake_hash(_path: str) -> str:
        return "hash"

    monkeypatch.setattr("app.services.scanner_service.get_file_hash", fake_hash)
    monkeypatch.setattr(
        "app.services.scanner_service.parse_audio",
        lambda _path: {"title": None, "author": None, "duration": 60, "chapters": []},
    )

    metadata = await parse_book_file(str(book_file), BookFormat.mp3, str(library_root))

    assert metadata["author"] == "Andy Weir"
    assert metadata["title"] == "Project Hail Mary"
    assert metadata["folder_chapter_title"] == "Track"


@pytest.mark.asyncio
async def test_scanner_uses_book_root_folder_layout(tmp_path, monkeypatch):
    library_root = tmp_path / "books" / "Andy Weir" / "Project Hail Mary"
    book_file = library_root / "Chapters" / "01 - Track.mp3"
    book_file.parent.mkdir(parents=True)
    book_file.write_bytes(b"audio")

    async def fake_hash(_path: str) -> str:
        return "hash"

    monkeypatch.setattr("app.services.scanner_service.get_file_hash", fake_hash)
    monkeypatch.setattr(
        "app.services.scanner_service.parse_audio",
        lambda _path: {"title": None, "author": None, "duration": 60, "chapters": []},
    )

    metadata = await parse_book_file(str(book_file), BookFormat.mp3, str(library_root))

    assert metadata["author"] == "Andy Weir"
    assert metadata["title"] == "Project Hail Mary"
    assert metadata["folder_chapter_title"] == "Track"


@pytest.mark.asyncio
async def test_scanner_groups_audiobook_chapter_folder(db_session, test_user, tmp_path, monkeypatch):
    library_root = tmp_path / "books"
    chapter_1 = library_root / "Octavia Butler" / "Kindred" / "Chapters" / "01 - Start.mp3"
    chapter_2 = library_root / "Octavia Butler" / "Kindred" / "Chapters" / "02 - End.mp3"
    chapter_1.parent.mkdir(parents=True)
    chapter_1.write_bytes(b"audio-1")
    chapter_2.write_bytes(b"audio-2")

    library = Library(
        name="Audiobooks",
        path=str(library_root),
        type=LibraryType.audiobook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)

    monkeypatch.setattr(
        "app.services.scanner_service.parse_audio",
        lambda path: {"title": None, "author": None, "duration": 60 if "01" in path else 90, "chapters": []},
    )
    monkeypatch.setattr("app.services.scanner_service.index_book_in_meili", lambda *_args, **_kwargs: None)

    result = await scan_library(db_session, object(), library.id)

    assert result["new"] == 1
    books = (await db_session.execute(select(Book))).scalars().all()
    assert len(books) == 1
    assert books[0].author == "Octavia Butler"
    assert books[0].title == "Kindred"
    assert books[0].duration == 150
    assert books[0].extra_metadata["audio_files"] == [str(chapter_1), str(chapter_2)]
    assert [chapter.title for chapter in books[0].chapters] == ["Start", "End"]


@pytest.mark.asyncio
async def test_scanner_merges_ebook_and_audiobook_in_same_book_folder(db_session, test_user, tmp_path, monkeypatch):
    library_root = tmp_path / "books"
    book_folder = library_root / "Octavia Butler" / "Kindred"
    ebook = book_folder / "Kindred.epub"
    audio = book_folder / "Chapters" / "01 - Start.mp3"
    audio.parent.mkdir(parents=True)
    ebook.write_bytes(b"ebook")
    audio.write_bytes(b"audio")

    library = Library(
        name="Mixed",
        path=str(library_root),
        type=LibraryType.mixed,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)

    async def fake_hash(path: str) -> str:
        return hashlib.sha256(path.encode("utf-8")).hexdigest()

    monkeypatch.setattr("app.services.scanner_service.get_file_hash", fake_hash)
    monkeypatch.setattr(
        "app.services.scanner_service.parse_epub",
        lambda _path: {"title": "Kindred", "author": "Octavia Butler"},
    )
    monkeypatch.setattr(
        "app.services.scanner_service.parse_audio",
        lambda _path: {"title": None, "author": None, "duration": 60, "chapters": []},
    )
    monkeypatch.setattr("app.services.scanner_service.index_book_in_meili", lambda *_args, **_kwargs: None)

    result = await scan_library(db_session, object(), library.id)

    assert result["new"] == 1
    books = (await db_session.execute(select(Book))).scalars().all()
    assert len(books) == 1
    book = books[0]
    assert book.title == "Kindred"
    assert book.author == "Octavia Butler"
    assert book.file_format == BookFormat.epub
    assert book.file_path == str(ebook)
    assert book.has_ebook is True
    assert book.has_audiobook is True
    assert book.ebook_format == "epub"
    assert book.audiobook_format == "mp3"
    assert book.extra_metadata["ebook_path"] == str(ebook)
    assert book.extra_metadata["audiobook_path"] == str(audio)
    assert book.extra_metadata["audio_files"] == [str(audio)]


@pytest.mark.asyncio
async def test_scanner_merges_direct_audio_tracks_with_ebook_in_ebook_library(db_session, test_user, tmp_path, monkeypatch):
    library_root = tmp_path / "books"
    book_folder = library_root / "Gabor Maté MD" / "In the Realm of Hungry Ghosts"
    ebook = book_folder / "In the Realm of Hungry Ghosts.epub"
    audio_1 = book_folder / "In the Realm of Hungry Ghosts-00-00.mp3"
    audio_2 = book_folder / "In the Realm of Hungry Ghosts-01-01.mp3"
    standalone_audio = library_root / "Audio Only Author" / "Audio Only Book" / "Audio Only Book-01-01.mp3"
    book_folder.mkdir(parents=True)
    standalone_audio.parent.mkdir(parents=True)
    ebook.write_bytes(b"ebook")
    audio_1.write_bytes(b"audio-1")
    audio_2.write_bytes(b"audio-2")
    standalone_audio.write_bytes(b"standalone-audio")

    library = Library(
        name="Ebooks",
        path=str(library_root),
        type=LibraryType.ebook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)

    async def fake_hash(path: str) -> str:
        return hashlib.sha256(path.encode("utf-8")).hexdigest()

    monkeypatch.setattr("app.services.scanner_service.get_file_hash", fake_hash)
    monkeypatch.setattr(
        "app.services.scanner_service.parse_epub",
        lambda _path: {"title": "In the Realm of Hungry Ghosts", "author": "Gabor Maté, M.D."},
    )
    monkeypatch.setattr(
        "app.services.scanner_service.parse_audio",
        lambda path: {"title": None, "author": None, "duration": 60 if "00-00" in path else 90, "chapters": []},
    )
    monkeypatch.setattr("app.services.scanner_service.index_book_in_meili", lambda *_args, **_kwargs: None)

    result = await scan_library(db_session, object(), library.id)

    assert result["new"] == 1
    books = (await db_session.execute(select(Book))).scalars().all()
    assert len(books) == 1
    book = books[0]
    assert book.title == "In the Realm of Hungry Ghosts"
    assert book.author == "Gabor Maté, M.D."
    assert book.file_format == BookFormat.epub
    assert book.has_ebook is True
    assert book.has_audiobook is True
    assert book.extra_metadata["ebook_path"] == str(ebook)
    assert book.extra_metadata["audiobook_path"] == str(audio_1)
    assert book.extra_metadata["audio_files"] == [str(audio_1), str(audio_2)]
    assert [chapter.title for chapter in book.chapters] == [
        "In the Realm of Hungry Ghosts-00-00",
        "In the Realm of Hungry Ghosts-01-01",
    ]


@pytest.mark.asyncio
async def test_scanner_updates_existing_ebook_row_when_audio_tracks_are_added(db_session, test_user, tmp_path, monkeypatch):
    library_root = tmp_path / "books"
    book_folder = library_root / "Gabor Maté MD" / "In the Realm of Hungry Ghosts"
    ebook = book_folder / "In the Realm of Hungry Ghosts.epub"
    audio = book_folder / "In the Realm of Hungry Ghosts-00-00.mp3"
    book_folder.mkdir(parents=True)
    ebook.write_bytes(b"ebook")
    audio.write_bytes(b"audio")

    library = Library(
        name="Ebooks",
        path=str(library_root),
        type=LibraryType.ebook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)

    existing = Book(
        library_id=library.id,
        title="In the Realm of Hungry Ghosts",
        author="Gabor Maté, M.D.",
        file_path=str(ebook),
        file_format=BookFormat.epub,
        file_size=ebook.stat().st_size,
        file_hash=str(ebook),
    )
    db_session.add(existing)
    await db_session.commit()
    await db_session.refresh(existing)
    existing_id = existing.id

    async def fake_hash(path: str) -> str:
        return hashlib.sha256(path.encode("utf-8")).hexdigest()

    monkeypatch.setattr("app.services.scanner_service.get_file_hash", fake_hash)
    monkeypatch.setattr(
        "app.services.scanner_service.parse_epub",
        lambda _path: {"title": "In the Realm of Hungry Ghosts", "author": "Gabor Maté, M.D."},
    )
    monkeypatch.setattr(
        "app.services.scanner_service.parse_audio",
        lambda _path: {"title": None, "author": None, "duration": 60, "chapters": []},
    )
    monkeypatch.setattr("app.services.scanner_service.index_book_in_meili", lambda *_args, **_kwargs: None)

    result = await scan_library(db_session, object(), library.id)

    assert result["new"] == 0
    assert result["updated"] == 1
    assert result["removed"] == 0
    books = (await db_session.execute(select(Book))).scalars().all()
    assert len(books) == 1
    book = books[0]
    assert book.id == existing_id
    assert book.has_ebook is True
    assert book.has_audiobook is True
    assert book.extra_metadata["audio_files"] == [str(audio)]
    assert [ch.title for ch in book.chapters] == ["In the Realm of Hungry Ghosts-00-00"]


@pytest.mark.asyncio
async def test_scanner_allows_grouped_audiobook_larger_than_int32(db_session, test_user, tmp_path, monkeypatch):
    library = Library(
        name="Audiobooks",
        path=str(tmp_path),
        type=LibraryType.audiobook,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)

    book = await add_book_to_db(
        db_session,
        library.id,
        {
            "title": "Dune",
            "author": "Frank Herbert",
            "file_path": "/books/Frank Herbert/Dune/Dune-01-01.m4b",
            "file_format": "m4b",
            "file_hash": "grouped-large-book",
            "file_size": 4_816_577_360,
            "audio_files": [
                "/books/Frank Herbert/Dune/Dune-01-01.m4b",
                "/books/Frank Herbert/Dune/Dune-02-02.m4b",
            ],
        },
    )

    assert book is not None
    assert book.file_size == 4_816_577_360
