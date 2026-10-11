from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker
from app.models.book import Book, BookFormat
from app.models.user import User
from app.services.book_service import update_progress, get_progress


async def make_book(db, library):
    book = Book(id=uuid.uuid4(), library_id=library.id, title='Timestamp Book', file_path='/tmp/timestamp.epub', file_format=BookFormat.epub, file_size=1000)
    db.add(book)
    await db.commit()
    return book


@pytest.mark.asyncio
async def test_stale_and_duplicate_snapshots_cannot_overwrite_newer_position(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    now = int(datetime.now(timezone.utc).timestamp()*1000)
    async def save(position, captured):
        return await client.post(f'/books/{book.id}/progress', json={'position': position, 'progress': position / 100, 'location': f'cfi-{position}', 'captured_at': captured, 'expected_user_id': str(test_user.id)})
    newest = await save(90, now)
    assert newest.status_code == 200
    for stamp in (now-1000, now):
        old = await save(30, stamp)
        assert old.json()['position'] == 90
        assert old.json()['location'] == 'cfi-90'
        assert old.json()['position_updated_at'] == newest.json()['position_updated_at']
    legacy_replay = await client.post(f'/books/{book.id}/progress', json={'position': 10, 'progress': 0.1})
    assert legacy_replay.json()['position'] == 90
    backward_seek = await save(20, now+1)
    assert backward_seek.json()['position'] == 20
    for field in ('last_updated', 'position_updated_at'):
        assert datetime.fromisoformat(backward_seek.json()[field].replace('Z', '+00:00')).utcoffset().total_seconds() == 0


@pytest.mark.asyncio
async def test_account_mismatch_is_rejected(client, db_session, test_library):
    book = await make_book(db_session, test_library)
    response = await client.post(f'/books/{book.id}/progress', json={'position': 20, 'progress': 0.2, 'expected_user_id': str(uuid.uuid4())})
    assert response.status_code == 403
    assert (await client.get(f'/books/{book.id}/progress')).json() is None


@pytest.mark.asyncio
async def test_positions_are_independent_for_each_user(db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    other = User(id=uuid.uuid4(), username='timestamp-other', email='timestamp@example.com')
    db_session.add(other)
    await db_session.commit()
    await update_progress(db_session, test_user.id, book.id, 85, 0.85, 'one', captured_at=100)
    await update_progress(db_session, other.id, book.id, 20, 0.2, 'two', captured_at=200)
    assert (await get_progress(db_session, test_user.id, book.id)).position == 85
    assert (await get_progress(db_session, other.id, book.id)).position == 20


@pytest.mark.asyncio
async def test_concurrent_first_saves_keep_single_newest_row(engine, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    sessions = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async def save(stamp, pos):
        async with sessions() as db:
            await update_progress(db, test_user.id, book.id, pos, pos/100, captured_at=stamp)
    await asyncio.gather(save(100, 30), save(200, 80))
    stored = await get_progress(db_session, test_user.id, book.id)
    assert stored.position == 80 and stored.captured_at == 200


@pytest.mark.asyncio
async def test_completion_review_and_position_times_are_separate_utc_values(client, db_session, test_user, test_library):
    book = await make_book(db_session, test_library)
    saved = await client.post(f'/books/{book.id}/progress', json={'position': 85, 'progress': 0.85})
    completed = await client.post(f'/books/{book.id}/complete')
    reviewed = await client.put(f'/books/{book.id}/review', json={'rating': 4})
    result = reviewed.json()
    assert result['position_updated_at'] == saved.json()['position_updated_at']
    assert result['completed_at'] == completed.json()['completed_at']
    for field in ('completed_at', 'review_updated_at', 'position_updated_at', 'last_updated'):
        assert datetime.fromisoformat(result[field].replace('Z', '+00:00')).utcoffset().total_seconds() == 0


@pytest.mark.asyncio
async def test_future_snapshots_are_rejected(client, db_session, test_library):
    book = await make_book(db_session, test_library)
    future = int(datetime.now(timezone.utc).timestamp()*1000)+3600000
    response = await client.post(f'/books/{book.id}/progress', json={'position': 10, 'captured_at': future})
    assert response.status_code == 422
