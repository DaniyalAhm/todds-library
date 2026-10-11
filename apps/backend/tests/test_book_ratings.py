from __future__ import annotations

import uuid
from datetime import datetime, timezone, timedelta
import pytest
from app.models.book import Book, BookFormat
from app.models.library import Library, LibraryType
from app.models.progress import ReadingProgress
from app.models.user import User


async def make_book(db, library, title='Shared Book', author='An Author', **kwargs):
    book = Book(id=uuid.uuid4(), library_id=library.id, title=title, author=author, file_path='/tmp/shared.epub', file_format=BookFormat.epub, file_size=1000, **kwargs)
    db.add(book)
    await db.commit()
    return book


@pytest.mark.asyncio
async def test_ratings_include_other_users_copies_without_private_review_data(client, db_session, test_user, test_library):
    own = await make_book(db_session, test_library)
    other = User(id=uuid.uuid4(), username='other-rating', email='private-email@example.com', is_admin=False)
    db_session.add(other)
    await db_session.commit()
    library = Library(id=uuid.uuid4(), name='Other library', path='/tmp/other', type=LibraryType.mixed, user_id=other.id)
    db_session.add(library)
    await db_session.commit()
    copy = await make_book(db_session, library, title=' shared book ', author='AN AUTHOR')
    unrelated = await make_book(db_session, library, author='Different Author')
    now = datetime.now(timezone.utc)
    db_session.add_all([
        ReadingProgress(user_id=test_user.id, book_id=own.id, progress=0.85, completed=True, rating=4, review_text='Private text', review_updated_at=now),
        ReadingProgress(user_id=other.id, book_id=copy.id, progress=1, rating=2, review_text='Other private text', review_updated_at=now),
        ReadingProgress(user_id=other.id, book_id=unrelated.id, progress=1, rating=5, review_updated_at=now),
    ])
    await db_session.commit()
    response = await client.get(f'/books/{own.id}/ratings')
    assert response.status_code == 200
    assert response.json() == {'average_rating': 3.0, 'rating_count': 2, 'distribution': {'1': 0, '2': 1, '3': 0, '4': 1, '5': 0}}
    assert 'Private' not in response.text and other.email not in response.text
    assert (await client.get(f'/books/{copy.id}/ratings')).status_code == 404


@pytest.mark.asyncio
async def test_ratings_count_each_user_once_using_latest_review(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    copy = await make_book(db_session, test_library)
    now = datetime.now(timezone.utc)
    db_session.add_all([
        ReadingProgress(user_id=test_user.id, book_id=book.id, progress=1, rating=2, review_updated_at=now-timedelta(days=1)),
        ReadingProgress(user_id=test_user.id, book_id=copy.id, progress=1, rating=5, review_updated_at=now),
    ])
    await db_session.commit()
    response = await client.get(f'/books/{book.id}/ratings')
    assert response.json()['average_rating'] == 5
    assert response.json()['rating_count'] == 1


@pytest.mark.asyncio
async def test_ratings_match_book_identifier_and_update_on_review_edit(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library, title='Edition one', isbn='1234567890')
    copy = await make_book(db_session, test_library, title='Edition two', isbn='1234567890')
    db_session.add(ReadingProgress(user_id=test_user.id, book_id=copy.id, progress=1, rating=4))
    await db_session.commit()
    assert (await client.get(f'/books/{book.id}/ratings')).json()['average_rating'] == 4
    assert (await client.put(f'/books/{copy.id}/review', json={'rating': 3})).status_code == 200
    assert (await client.get(f'/books/{book.id}/ratings')).json()['average_rating'] == 3


@pytest.mark.asyncio
async def test_ratings_empty_and_missing_book(client, db_session, test_library):
    book = await make_book(db_session, test_library)
    response = await client.get(f'/books/{book.id}/ratings')
    assert response.json()['average_rating'] is None
    assert response.json()['rating_count'] == 0
    assert (await client.get(f'/books/{uuid.uuid4()}/ratings')).status_code == 404
