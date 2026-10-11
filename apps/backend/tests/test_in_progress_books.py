from datetime import datetime, timedelta, timezone
import uuid

import pytest

from app.models.book import Book, BookFormat
from app.models.progress import ReadingProgress
from app.models.user import User


@pytest.mark.asyncio
async def test_in_progress_filters_before_pagination_and_sorts_by_reading_activity(
    client, db_session, test_user, test_library,
):
    now = datetime.now(timezone.utc)
    other = User(id=uuid.uuid4(), username='other-reader', email='other@example.com', is_admin=False)
    db_session.add(other)
    books = []
    for index in range(18):
        book = Book(id=uuid.uuid4(), library_id=test_library.id, title=f'Book {index:02}',
                    file_path=f'/tmp/in-progress-{index}', file_format=BookFormat.epub, file_size=1,
                    updated_at=now + timedelta(days=index))
        db_session.add(book)
        books.append(book)
    await db_session.flush()
    db_session.add_all([
        ReadingProgress(user_id=test_user.id, book_id=books[0].id, progress=0.2, position=20,
                        position_updated_at=now, last_updated=now + timedelta(days=5)),
        ReadingProgress(user_id=test_user.id, book_id=books[1].id, progress=0.3, position=30,
                        last_updated=now + timedelta(days=1)),
        ReadingProgress(user_id=test_user.id, book_id=books[2].id, progress=0.9, position=90, completed=True),
        ReadingProgress(user_id=test_user.id, book_id=books[3].id, progress=1, position=100),
        ReadingProgress(user_id=test_user.id, book_id=books[4].id, progress=0, position=0),
        ReadingProgress(user_id=other.id, book_id=books[5].id, progress=0.5, position=50),
    ])
    await db_session.commit()
    params = dict(in_progress='true', sort='progress_updated_at', order='desc', limit=1)
    response = await client.get('/books', params=params)
    assert response.status_code == 200
    assert response.json()['total'] == 2
    assert [item['id'] for item in response.json()['items']] == [str(books[1].id)]
    response = await client.get('/books', params={**params, 'offset': 1})
    assert [item['id'] for item in response.json()['items']] == [str(books[0].id)]
    response = await client.get('/books')
    assert response.json()['total'] == 18
