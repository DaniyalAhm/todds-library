from __future__ import annotations

import uuid
import pytest
from app.models.book import Book, BookFormat
from app.models.progress import ReadingProgress
from app.models.user import User
from app.services.book_service import update_progress


async def make_book(db_session, test_library, file_format=BookFormat.epub):
    book = Book(id=uuid.uuid4(), library_id=test_library.id, title='Completion Book', file_path='/tmp/completion-book', file_format=file_format, file_size=1000)
    db_session.add(book)
    await db_session.commit()
    return book


@pytest.mark.asyncio
@pytest.mark.parametrize('value', [0, 0.84, 0.84999])
async def test_completion_requires_at_least_85_percent(client, db_session, test_user, test_library, value):
    book = await make_book(db_session, test_library)
    await update_progress(db_session, test_user.id, book.id, 42, value, 'saved-cfi')
    response = await client.post(f'/books/{book.id}/complete')
    assert response.status_code == 400
    progress = await client.get(f'/books/{book.id}/progress')
    assert progress.json()['completed'] is False


@pytest.mark.asyncio
@pytest.mark.parametrize('file_format', [BookFormat.epub, BookFormat.m4b])
async def test_completion_preserves_position_and_survives_progress_sync(client, db_session, test_user, test_library, file_format):
    book = await make_book(db_session, test_library, file_format)
    await update_progress(db_session, test_user.id, book.id, 850, 0.85, 'saved-cfi')
    response = await client.post(f'/books/{book.id}/complete')
    assert response.status_code == 200
    result = response.json()
    assert result['completed'] is True
    assert result['completed_at']
    assert result['position'] == 850 and result['location'] == 'saved-cfi'
    assert result['progress'] == 0.85
    saved = await client.post(f'/books/{book.id}/progress', json={'position': 840, 'progress': 0.84, 'location': 'new-cfi'})
    assert saved.json()['completed'] is True
    repeated = await client.post(f'/books/{book.id}/complete')
    assert repeated.status_code == 200
    assert repeated.json()['completed_at'] == result['completed_at']
    detail = await client.get(f'/books/{book.id}')
    assert detail.json()['progress'] == 1


@pytest.mark.asyncio
async def test_other_users_progress_does_not_grant_completion(client, db_session, test_library):
    book = await make_book(db_session, test_library)
    other = User(id=uuid.uuid4(), username='other-reader', email='other@example.com', is_admin=False)
    db_session.add(other)
    await db_session.commit()
    db_session.add(ReadingProgress(user_id=other.id, book_id=book.id, progress=0.99, position=99))
    await db_session.commit()
    response = await client.post(f'/books/{book.id}/complete')
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_completion_denies_missing_book(client):
    response = await client.post(f'/books/{uuid.uuid4()}/complete')
    assert response.status_code == 404
