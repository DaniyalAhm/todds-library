from __future__ import annotations

import uuid
import pytest
from app.models.book import Book, BookFormat
from app.models.user import User
from app.services.book_service import update_progress
from app.services.auth_service import create_user_jwt


async def make_book(db_session, test_library):
    book = Book(id=uuid.uuid4(), library_id=test_library.id, title='Review Book', file_path='/tmp/review-book.epub', file_format=BookFormat.epub, file_size=1000)
    db_session.add(book)
    await db_session.commit()
    return book


@pytest.mark.asyncio
async def test_review_requires_completion(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    for progress in [None, 0.85, 0.99]:
        if progress is not None:
            await update_progress(db_session, test_user.id, book.id, 85, progress)
        response = await client.put(f'/books/{book.id}/review', json={'rating': 4, 'review_text': 'Great book'})
        assert response.status_code == 400


@pytest.mark.asyncio
async def test_review_can_be_saved_edited_and_survives_progress_sync(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    await update_progress(db_session, test_user.id, book.id, 85, 0.85, 'saved-cfi')
    assert (await client.post(f'/books/{book.id}/complete')).status_code == 200
    response = await client.put(f'/books/{book.id}/review', json={'rating': 4, 'review_text': '  Loved it  '})
    assert response.status_code == 200
    saved = response.json()
    assert saved['rating'] == 4 and saved['review_text'] == 'Loved it'
    assert saved['review_updated_at']
    assert saved['position'] == 85 and saved['location'] == 'saved-cfi'
    edited = await client.put(f'/books/{book.id}/review', json={'rating': 5, 'review_text': ''})
    assert edited.json()['rating'] == 5 and edited.json()['review_text'] is None
    synced = await client.post(f'/books/{book.id}/progress', json={'position': 90, 'progress': 0.9})
    assert synced.json()['rating'] == 5
    assert synced.json()['completed'] is True


@pytest.mark.asyncio
async def test_full_progress_allows_review_without_manual_completion(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    await update_progress(db_session, test_user.id, book.id, 100, 1.0)
    response = await client.put(f'/books/{book.id}/review', json={'rating': 3})
    assert response.status_code == 200
    assert response.json()['completed'] is True
    await client.post(f'/books/{book.id}/progress', json={'position': 90, 'progress': 0.9})
    assert (await client.put(f'/books/{book.id}/review', json={'rating': 4})).status_code == 200


@pytest.mark.asyncio
@pytest.mark.parametrize('rating', [0, 6, 2.5, '4', True])
async def test_review_validates_rating(client, db_session, test_user, test_library, rating):
    book = await make_book(db_session, test_library)
    await update_progress(db_session, test_user.id, book.id, 100, 1)
    response = await client.put(f'/books/{book.id}/review', json={'rating': rating})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_review_is_private_and_scoped_to_book_access(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    await update_progress(db_session, test_user.id, book.id, 100, 1)
    await client.put(f'/books/{book.id}/review', json={'rating': 5, 'review_text': 'Private thoughts'})
    other = User(id=uuid.uuid4(), username='review-other', email='review-other@example.com', is_admin=False)
    db_session.add(other)
    await db_session.commit()
    headers = {'Authorization': f'Bearer {create_user_jwt(other)}'}
    assert (await client.get(f'/books/{book.id}/progress', headers=headers)).status_code == 404
    assert (await client.put(f'/books/{book.id}/review', json={'rating': 1}, headers=headers)).status_code == 404


@pytest.mark.asyncio
async def test_review_limits_text_length(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    await update_progress(db_session, test_user.id, book.id, 100, 1)
    response = await client.put(f'/books/{book.id}/review', json={'rating': 4, 'review_text': 'x' * 5001})
    assert response.status_code == 422
