from __future__ import annotations

import asyncio
import uuid
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.database import Base
from app.dependencies import get_db
from app.models.book import Book
from app.models.bookmark import Bookmark
from app.models.chapter import Chapter
from app.models.metadata_cache import MetadataCache
from app.models.progress import ReadingProgress
from app.models.library import Library, LibraryType
from app.models.user import User
from app.services.auth_service import create_user_jwt

TEST_DATABASE_URL = "sqlite+aiosqlite:///./test.db"


@pytest.fixture(scope="session")
def event_loop():
    loop = asyncio.new_event_loop()
    yield loop
    loop.close()


@pytest_asyncio.fixture(scope="session")
async def engine():
    engine = create_async_engine(TEST_DATABASE_URL, echo=True)
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    yield engine
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(engine) -> AsyncGenerator[AsyncSession, None]:
    session_factory = async_sessionmaker(
        bind=engine, class_=AsyncSession, expire_on_commit=False
    )
    async with session_factory() as session:
        for model in (
            Bookmark,
            ReadingProgress,
            Chapter,
            Book,
            MetadataCache,
            Library,
            User,
        ):
            await session.execute(delete(model))
        await session.commit()
        yield session


@pytest_asyncio.fixture
async def test_user(db_session: AsyncSession) -> User:
    user = User(
        id=uuid.uuid4(),
        username="testuser",
        email="test@example.com",
        authentik_sub="test-sub-123",
        is_admin=True,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest_asyncio.fixture
async def test_library(db_session: AsyncSession, test_user: User) -> Library:
    library = Library(
        id=uuid.uuid4(),
        name="Test Library",
        path="/tmp/test-books",
        type=LibraryType.mixed,
        user_id=test_user.id,
    )
    db_session.add(library)
    await db_session.commit()
    await db_session.refresh(library)
    return library


@pytest_asyncio.fixture
async def client(engine, db_session: AsyncSession, test_user: User) -> AsyncGenerator[AsyncClient, None]:
    app = FastAPI()

    from app.api.router import router
    app.include_router(router)

    async def override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = override_get_db

    token = create_user_jwt(test_user)

    transport = ASGITransport(app=app)
    async with AsyncClient(
        transport=transport,
        base_url="http://test",
        headers={"Authorization": f"Bearer {token}"},
    ) as ac:
        yield ac
