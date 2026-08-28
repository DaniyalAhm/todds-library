from __future__ import annotations

import asyncio
import json
import os
import subprocess
import uuid

import httpx
from sqlalchemy import select

from app.database import AsyncSessionLocal
from app.models.book import Book, BookFormat
from app.models.library import Library, LibraryType
from app.models.user import User
from app.services.auth_service import create_user_jwt


AUDIO_PATH = "/tmp/todds-mobile-backend-probe.mp3"
BOOK_HASH = "mobile-backend-probe-audio"
USERNAME = "mobile_backend_probe_e2e"
BASE_URL = os.environ.get("MOBILE_PROBE_BASE_URL", "http://127.0.0.1:8000/api")
ANDROID_CHROME_UA = (
    "Mozilla/5.0 (Linux; Android 14; Pixel 7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/126.0.0.0 Mobile Safari/537.36"
)


async def ensure_fixture() -> tuple[str, str]:
    if not os.path.isfile(AUDIO_PATH):
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=587:duration=30",
                "-codec:a",
                "libmp3lame",
                "-b:a",
                "96k",
                AUDIO_PATH,
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    async with AsyncSessionLocal() as db:
        user = (
            await db.execute(select(User).where(User.username == USERNAME))
        ).scalar_one_or_none()
        if user is None:
            user = User(
                id=uuid.uuid4(),
                username=USERNAME,
                email="mobile-backend-probe@example.local",
                is_admin=False,
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)

        library = (
            await db.execute(
                select(Library).where(
                    Library.name == "Mobile Backend Probe Library",
                    Library.user_id == user.id,
                )
            )
        ).scalar_one_or_none()
        if library is None:
            library = Library(
                id=uuid.uuid4(),
                name="Mobile Backend Probe Library",
                path="/tmp",
                type=LibraryType.audiobook,
                user_id=user.id,
            )
            db.add(library)
            await db.commit()
            await db.refresh(library)

        book = (
            await db.execute(
                select(Book).where(Book.file_hash == BOOK_HASH, Book.library_id == library.id)
            )
        ).scalar_one_or_none()
        metadata = {
            "audiobook_path": AUDIO_PATH,
            "audiobook_format": "mp3",
            "audio_files": [AUDIO_PATH],
            "audio_health": {"status": "ok"},
        }
        if book is None:
            book = Book(
                id=uuid.uuid4(),
                library_id=library.id,
                title="Mobile Backend Probe Audio",
                author="E2E",
                file_path=AUDIO_PATH,
                file_format=BookFormat.mp3,
                file_size=os.path.getsize(AUDIO_PATH),
                file_hash=BOOK_HASH,
                duration=30.0,
                extra_metadata=metadata,
            )
            db.add(book)
        else:
            book.file_path = AUDIO_PATH
            book.file_size = os.path.getsize(AUDIO_PATH)
            book.duration = 30.0
            book.extra_metadata = metadata

        await db.commit()
        await db.refresh(book)
        return str(book.id), create_user_jwt(user)


async def read_partial_then_close(client: httpx.AsyncClient, url: str, byte_range: str) -> int:
    bytes_read = 0
    async with client.stream("GET", url, headers={"Range": byte_range}) as response:
        assert response.status_code == 206, response.status_code
        assert response.headers.get("accept-ranges") == "bytes"
        async for chunk in response.aiter_bytes():
            bytes_read += len(chunk)
            if bytes_read >= 4096:
                break
    return bytes_read


async def main() -> None:
    book_id, token = await ensure_fixture()
    url = f"{BASE_URL}/audiobooks/{book_id}/download?access_token={token}"
    headers = {
        "User-Agent": ANDROID_CHROME_UA,
        "Accept": "audio/webm,audio/ogg,audio/wav,audio/*;q=0.9,*/*;q=0.8",
        "Connection": "keep-alive",
    }

    async with httpx.AsyncClient(timeout=30.0, headers=headers) as client:
        first = await client.get(url, headers={"Range": "bytes=0-8191"})
        assert first.status_code == 206, first.status_code
        assert first.headers.get("accept-ranges") == "bytes"
        assert first.headers.get("content-range", "").startswith("bytes 0-8191/")
        assert first.headers.get("content-length") == "8192"
        assert len(first.content) == 8192

        partial_reads = []
        for start in (8192, 16384, 24576):
            partial_reads.append(
                await read_partial_then_close(client, url, f"bytes={start}-{start + 8191}")
            )

        reconnect = await client.get(url, headers={"Range": "bytes=32768-40959"})
        assert reconnect.status_code == 206, reconnect.status_code
        assert reconnect.headers.get("content-range", "").startswith("bytes 32768-40959/")
        assert reconnect.headers.get("cache-control") == "no-store"
        assert len(reconnect.content) == 8192

    print(
        json.dumps(
            {
                "book_id": book_id,
                "first_status": first.status_code,
                "first_content_range": first.headers.get("content-range"),
                "partial_reads": partial_reads,
                "reconnect_status": reconnect.status_code,
                "reconnect_content_range": reconnect.headers.get("content-range"),
                "reconnect_bytes": len(reconnect.content),
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
