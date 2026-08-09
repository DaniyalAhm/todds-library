from __future__ import annotations

import pytest

from app.services import session_service


@pytest.mark.asyncio
async def test_create_and_get_session(redis_client):
    user_id = "user-123"

    session_id = await session_service.create_session(user_id)
    assert session_id
    assert session_id != user_id

    assert await session_service.get_session(session_id) == user_id
    assert await session_service.get_session("") is None
    assert await session_service.get_session("missing") is None


@pytest.mark.asyncio
async def test_session_slides_expiry(redis_client):
    session_id = await session_service.create_session("user-123")
    ttl = session_service._session_ttl_seconds()

    await session_service.get_session(session_id)
    remaining = await session_service.get_client().ttl(f"{session_service.SESSION_KEY_PREFIX}{session_id}")

    assert 0 < remaining <= ttl


@pytest.mark.asyncio
async def test_revoke_session(redis_client):
    session_id = await session_service.create_session("user-123")

    await session_service.revoke_session(session_id)
    assert await session_service.get_session(session_id) is None
    assert await session_service.get_client().exists(f"{session_service.SESSION_KEY_PREFIX}{session_id}") == 0


@pytest.mark.asyncio
async def test_revoke_all_user_sessions(redis_client):
    first = await session_service.create_session("user-123")
    second = await session_service.create_session("user-123")

    await session_service.revoke_all_user_sessions("user-123")

    assert await session_service.get_session(first) is None
    assert await session_service.get_session(second) is None
    assert await session_service.get_client().exists("user_sessions:user-123") == 0


@pytest.mark.asyncio
async def test_other_user_session_survives_revoke_all(redis_client):
    target = await session_service.create_session("user-123")
    other = await session_service.create_session("user-456")

    await session_service.revoke_all_user_sessions("user-123")

    assert await session_service.get_session(target) is None
    assert await session_service.get_session(other) == "user-456"
