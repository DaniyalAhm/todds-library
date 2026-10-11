import uuid

import pytest

from app.models.book import Book, BookFormat
from app.models.library import Library, LibraryType
from app.models.progress import ReadingProgress
from app.models.user import User


@pytest.mark.asyncio
async def test_book_stats_empty_library(client, test_library):
    response = await client.get('/books/stats')
    assert response.status_code == 200
    assert response.json() == {'total': 0, 'in_progress': 0, 'completed': 0, 'not_started': 0}


@pytest.mark.asyncio
async def test_book_stats_use_current_users_library_and_progress(client, db_session, test_user, test_library):
    other = User(id=uuid.uuid4(), username='stats-other', email='stats-other@example.com', is_admin=False)
    db_session.add(other)
    library = Library(id=uuid.uuid4(), name='Private', path='/tmp/private-stats', type=LibraryType.mixed, user_id=other.id)
    db_session.add(library)
    books = [Book(id=uuid.uuid4(), library_id=test_library.id if i < 6 else library.id,
                  title=f'Stats {i}', file_path=f'/tmp/stats-{i}', file_format=BookFormat.epub, file_size=1)
             for i in range(7)]
    db_session.add_all(books)
    await db_session.flush()
    db_session.add_all([
        ReadingProgress(user_id=test_user.id, book_id=books[0].id, progress=0.4, position=4),
        ReadingProgress(user_id=test_user.id, book_id=books[1].id, progress=0.85, position=8, completed=True),
        ReadingProgress(user_id=test_user.id, book_id=books[2].id, progress=1, position=10),
        ReadingProgress(user_id=test_user.id, book_id=books[3].id, progress=0, position=0),
        ReadingProgress(user_id=other.id, book_id=books[4].id, progress=1, position=10),
        ReadingProgress(user_id=test_user.id, book_id=books[6].id, progress=1, position=10),
    ])
    await db_session.commit()
    response = await client.get('/books/stats')
    assert response.status_code == 200
    assert response.json() == {'total': 6, 'in_progress': 1, 'completed': 2, 'not_started': 3}
