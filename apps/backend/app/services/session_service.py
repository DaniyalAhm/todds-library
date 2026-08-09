from __future__ import annotations

import json
import logging
import secrets
from typing import Any

from redis.asyncio import Redis

from app.config import settings

logger = logging.getLogger(__name__)

_client: Redis | None = None

SESSION_KEY_PREFIX = "sess:"
USER_SESSIONS_KEY_PREFIX = "user_sessions:"

_redis_kwargs: dict[str, Any] = {}


def _session_ttl_seconds() -> int:
    return settings.session_ttl_days * 24 * 60 * 60


def get_client() -> Redis:
    if _client is None:
        raise RuntimeError("Redis client is not initialized")
    return _client


def set_redis_client(client: Redis | None) -> None:
    """Override the client (used by tests and for explicit setup)."""
    global _client
    _client = client


async def init_redis() -> Redis:
    global _client
    if _client is None:
        client = Redis.from_url(settings.redis_url, decode_responses=True, **_redis_kwargs)
        await client.ping()
        _client = client
        logger.info("Connected to Redis at %s", settings.redis_url)
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def create_session(user_id: str) -> str:
    client = get_client()
    session_id = secrets.token_urlsafe(32)
    payload = json.dumps({"user_id": str(user_id)})
    ttl = _session_ttl_seconds()
    await client.set(f"{SESSION_KEY_PREFIX}{session_id}", payload, ex=ttl)
    await client.sadd(f"{USER_SESSIONS_KEY_PREFIX}{user_id}", session_id)
    await client.expire(f"{USER_SESSIONS_KEY_PREFIX}{user_id}", ttl)
    return session_id


async def get_session(session_id: str) -> str | None:
    """Return the user_id for a valid session, or None if missing/revoked/expired."""
    if not session_id:
        return None
    client = get_client()
    raw = await client.get(f"{SESSION_KEY_PREFIX}{session_id}")
    if raw is None:
        return None
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        return None
    user_id = payload.get("user_id")
    if not user_id:
        return None
    await client.expire(f"{SESSION_KEY_PREFIX}{session_id}", _session_ttl_seconds())
    return str(user_id)


async def revoke_session(session_id: str) -> None:
    if not session_id:
        return
    client = get_client()
    raw = await client.get(f"{SESSION_KEY_PREFIX}{session_id}")
    await client.delete(f"{SESSION_KEY_PREFIX}{session_id}")
    if raw:
        try:
            user_id = json.loads(raw).get("user_id")
        except json.JSONDecodeError:
            user_id = None
        if user_id:
            await client.srem(f"{USER_SESSIONS_KEY_PREFIX}{user_id}", session_id)


async def revoke_all_user_sessions(user_id: str) -> None:
    client = get_client()
    key = f"{USER_SESSIONS_KEY_PREFIX}{user_id}"
    session_ids = await client.smembers(key)
    if session_ids:
        async with client.pipeline(transaction=True) as pipe:
            for session_id in session_ids:
                pipe.delete(f"{SESSION_KEY_PREFIX}{session_id}")
            pipe.delete(key)
            await pipe.execute()
