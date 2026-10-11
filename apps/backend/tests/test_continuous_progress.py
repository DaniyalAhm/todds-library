import uuid
import pytest
from app.models.book import Book
from app.models.book import BookFormat
from app.services.book_service import get_progress, update_progress


@pytest.mark.asyncio
async def test_continuous_half_second_sync_writes_to_db(db_session, test_user, test_library):
    # create a book for this test
    test_book = Book(
        id=uuid.uuid4(),
        library_id=test_library.id,
        title="Continuous Sync Book",
        file_path="/tmp/test-books/book.epub",
        file_format=BookFormat.epub,
        file_size=1000,
    )
    db_session.add(test_book)
    await db_session.commit()
    await db_session.refresh(test_book)
    # Simulate frontend POSTing timestamps every 0.5s — each POST adds to DB
    book_id = test_book.id
    user_id = test_user.id

    # Initial progress
    rp = await update_progress(db_session, user_id, book_id, position=0.0, progress=0.0)
    assert rp.position == 0.0

    # Simulate 5 rapid 0.5s ticks as frontend would POST
    for i in range(1, 6):
        rp = await update_progress(
            db_session, user_id, book_id, position=float(i * 10), progress=i * 0.1, location=f"cfi-{i}"
        )
        stored = await get_progress(db_session, user_id, book_id)
        assert stored is not None
        assert stored.position == float(i * 10)
        assert stored.progress == pytest.approx(i * 0.1)
        assert stored.location == f"cfi-{i}"

    # Final state reflects latest timestamp
    final = await get_progress(db_session, user_id, book_id)
    assert final.position == 50.0
    assert final.progress == pytest.approx(0.5)


@pytest.mark.asyncio
async def test_continuous_sync_via_api_continuous_posts(client, db_session, test_user, test_library):
    """Integration: POST /books/{id}/progress every 500ms via API writes to DB."""
    # create a book for API test
    test_book = Book(
        id=uuid.uuid4(),
        library_id=test_library.id,
        title="API Continuous Sync Book",
        file_path="/tmp/test-books/book2.epub",
        file_format=BookFormat.epub,
        file_size=1000,
    )
    db_session.add(test_book)
    await db_session.commit()
    await db_session.refresh(test_book)
    book_id = test_book.id

    for pos in [0.0, 5.5, 10.2, 15.8]:
        resp = await client.post(
            f"/books/{book_id}/progress",
            json={"position": pos, "progress": pos / 100, "location": f"loc-{pos}"},
        )
        assert resp.status_code == 200, resp.text
        data = resp.json()
        assert data["position"] == pos

    # Verify GET returns last timestamp
    resp = await client.get(f"/books/{book_id}/progress")
    assert resp.status_code == 200
    assert resp.json()["position"] == 15.8
