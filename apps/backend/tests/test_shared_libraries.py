import uuid

import pytest

from app.models.book import Book, BookFormat
from app.models.progress import ReadingProgress
from app.models.user import User
from app.services.auth_service import create_user_jwt


@pytest.mark.asyncio
@pytest.mark.parametrize('username', ['existing-reader', 'new-reader'])
async def test_regular_users_can_read_admin_library_with_personal_progress(
    client, db_session, test_user, test_library, monkeypatch, username,
):
    reader = User(id=uuid.uuid4(), username=username, email=f'{username}@example.com', is_admin=False)
    db_session.add(reader)
    book = Book(id=uuid.uuid4(), library_id=test_library.id, title='Shared Book',
                file_path='/tmp/missing-shared.epub', file_format=BookFormat.epub, file_size=1)
    db_session.add(book)
    await db_session.flush()
    db_session.add(ReadingProgress(user_id=test_user.id, book_id=book.id, progress=0.8, position=80))
    await db_session.commit()
    headers = {'Authorization': f'Bearer {create_user_jwt(reader)}'}
    response = await client.get('/libraries', headers=headers)
    assert str(test_library.id) in {item['id'] for item in response.json()['items']}
    assert (await client.get(f'/libraries/{test_library.id}', headers=headers)).status_code == 200
    response = await client.get('/books', headers=headers)
    item = next(item for item in response.json()['items'] if item['id'] == str(book.id))
    assert item['progress'] == 0
    assert (await client.get(f'/books/{book.id}', headers=headers)).status_code == 200
    response = await client.get(f'/books/{book.id}/download', headers=headers)
    assert response.json() == {'detail': 'File not found'}
    response = await client.post(f'/books/{book.id}/progress', headers=headers, json={'position': 20, 'progress': 0.2})
    assert response.status_code == 200
    assert response.json()['user_id'] == str(reader.id)
    assert (await client.get(f'/books/{book.id}/progress')).json()['progress'] == 0.8
    response = await client.post(f'/books/{book.id}/bookmarks', headers=headers, json={'position': 20})
    assert response.status_code == 201
    assert (await client.get(f'/books/{book.id}/bookmarks')).json() == []
    stats = (await client.get('/books/stats', headers=headers)).json()
    assert stats['total'] == 1 and stats['in_progress'] == 1
    response = await client.get('/books', headers=headers, params={'in_progress': 'true'})
    assert response.json()['total'] == 1

    async def fail_meili(*args, **kwargs):
        raise RuntimeError('force fallback')
    monkeypatch.setattr('app.api.search.search_books', fail_meili)
    response = await client.get('/search', headers=headers, params={'q': 'Shared'})
    assert str(book.id) in {item['id'] for item in response.json()['results']}

    async def indexed_search(meili, query, library_ids, *args):
        assert test_library.id in library_ids
        return [{'id': str(book.id), 'title': book.title, 'file_format': 'epub', 'library_id': str(test_library.id)}]
    monkeypatch.setattr('app.api.search.search_books', indexed_search)
    response = await client.get('/search', headers=headers, params={'q': 'Shared'})
    assert response.status_code == 200 and response.json()['used_fallback'] is False
    assert (await client.delete(f'/libraries/{test_library.id}', headers=headers)).status_code == 403
    assert (await client.post(f'/libraries/{test_library.id}/scan', headers=headers)).status_code == 403
    assert (await client.delete(f'/books/{book.id}', headers=headers)).status_code == 403
    assert (await client.get('/libraries', headers={'Authorization': ''})).status_code == 401
