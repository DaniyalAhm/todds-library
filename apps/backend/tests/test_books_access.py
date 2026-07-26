from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.book import Book, BookFormat
from app.models.library import Library, LibraryType
from app.models.progress import ReadingProgress
from app.models.user import User
from app.services.auth_service import create_user_jwt


async def create_user_library_book(
    db_session: AsyncSession,
    *,
    username: str,
    title: str,
) -> tuple[User, Library, Book]:
    user = User(
        id=uuid.uuid4(),
        username=username,
        email=f"{username}@example.com",
        is_admin=True,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    library = Library(
        id=uuid.uuid4(),
        name=f"{username} Library",
        path=f"/tmp/{username}",
        type=LibraryType.mixed,
        user_id=user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)

    book = Book(
        id=uuid.uuid4(),
        library_id=library.id,
        title=title,
        author=username,
        file_path=f"/tmp/{username}/{title}.epub",
        file_format=BookFormat.epub,
        file_size=10,
        file_hash=f"{username}-{title}",
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)
    return user, library, book


@pytest.mark.asyncio
async def test_books_are_scoped_to_current_users_libraries(client, db_session):
    _owner, _library, owner_book = await create_user_library_book(
        db_session, username="owner", title="Owner Book"
    )

    response = await client.get("/books")
    assert response.status_code == 200
    assert all(item["id"] != str(owner_book.id) for item in response.json()["items"])

    response = await client.get(f"/books/{owner_book.id}")
    assert response.status_code == 404

    response = await client.get(f"/books/{owner_book.id}/cover")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_book_mutations_are_scoped_to_current_users_libraries(client, db_session):
    _owner, _library, owner_book = await create_user_library_book(
        db_session, username="owner", title="Owner Book"
    )

    progress = await client.post(
        f"/books/{owner_book.id}/progress",
        json={"position": 1, "progress": 0.5},
    )
    assert progress.status_code == 404

    bookmark = await client.post(
        f"/books/{owner_book.id}/bookmarks",
        json={"position": 1, "note": "private"},
    )
    assert bookmark.status_code == 404

    bookmarks = await client.get(f"/books/{owner_book.id}/bookmarks")
    assert bookmarks.status_code == 404


@pytest.mark.asyncio
async def test_progress_is_persisted_and_returned_from_database(client, db_session, test_library):
    book = Book(
        id=uuid.uuid4(),
        library_id=test_library.id,
        title="Progress Book",
        author="current",
        file_path="/tmp/current/progress.epub",
        file_format=BookFormat.epub,
        file_size=10,
        file_hash="progress-book",
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    first = await client.post(
        f"/books/{book.id}/progress",
        json={"position": 12.5, "progress": 0.25, "location": "epubcfi(/6/2)"},
    )
    assert first.status_code == 200
    assert first.json()["progress"] == 0.25

    saved = await db_session.execute(
        select(ReadingProgress).where(ReadingProgress.book_id == book.id)
    )
    progress_row = saved.scalar_one()
    assert progress_row.position == 12.5
    assert progress_row.progress == 0.25
    assert progress_row.location == "epubcfi(/6/2)"

    second = await client.post(
        f"/books/{book.id}/progress",
        json={"position": 21.0, "progress": 0.75, "location": "epubcfi(/8/2)"},
    )
    assert second.status_code == 200
    assert second.json()["progress"] == 0.75

    row_count = await db_session.execute(
        select(func.count(ReadingProgress.id)).where(ReadingProgress.book_id == book.id)
    )
    assert row_count.scalar_one() == 1

    list_response = await client.get("/books")
    assert list_response.status_code == 200
    list_item = next(
        item for item in list_response.json()["items"] if item["id"] == str(book.id)
    )
    assert list_item["progress"] == 0.75

    detail_response = await client.get(f"/books/{book.id}")
    assert detail_response.status_code == 200
    assert detail_response.json()["progress"] == 0.75


@pytest.mark.asyncio
async def test_search_requires_authentication_and_filters_to_current_user(client, db_session, monkeypatch, test_library):
    current_book = Book(
        id=uuid.uuid4(),
        library_id=test_library.id,
        title="Visible Result",
        author="current",
        file_path="/tmp/current.epub",
        file_format=BookFormat.epub,
        file_size=1,
        file_hash="current",
    )
    db_session.add(current_book)
    await db_session.commit()
    await db_session.refresh(current_book)

    _owner, _library, hidden_book = await create_user_library_book(
        db_session, username="owner", title="Hidden Result"
    )

    async def fail_meili(*_args, **_kwargs):
        raise RuntimeError("force fallback")

    monkeypatch.setattr("app.api.search.search_books", fail_meili)

    response = await client.get("/search", params={"q": "Result"})
    assert response.status_code == 200
    ids = {item["id"] for item in response.json()["results"]}
    assert str(current_book.id) in ids
    assert str(hidden_book.id) not in ids

    unauthenticated = await client.get("/search", params={"q": "Result"}, headers={"Authorization": ""})
    assert unauthenticated.status_code == 401


@pytest.mark.asyncio
async def test_media_routes_accept_query_access_token(client, db_session, test_user, test_library):
    book = Book(
        id=uuid.uuid4(),
        library_id=test_library.id,
        title="Media Token Book",
        author="current",
        file_path="/tmp/missing.epub",
        file_format=BookFormat.epub,
        file_size=1,
        file_hash="media-token",
    )
    db_session.add(book)
    await db_session.commit()
    await db_session.refresh(book)

    token = create_user_jwt(test_user)

    missing_token = await client.get(f"/books/{book.id}/download", headers={"Authorization": ""})
    assert missing_token.status_code == 401

    with_token = await client.get(
        f"/books/{book.id}/download",
        params={"access_token": token},
        headers={"Authorization": ""},
    )
    assert with_token.status_code == 404
    assert with_token.json() == {"detail": "File not found"}
