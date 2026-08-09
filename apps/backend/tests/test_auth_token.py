from __future__ import annotations

import uuid

import pytest

from app.models.user import User
from app.services.auth_service import create_user_jwt, hash_password, validate_app_token


async def _create_password_user(db_session, *, username: str = "alice", is_admin: bool = False) -> User:
    user = User(
        id=uuid.uuid4(),
        username=username,
        email=f"{username}@example.com",
        hashed_password=hash_password("s3cret-pass"),
        is_admin=is_admin,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest.mark.asyncio
async def test_login_returns_access_token(client, db_session):
    user = await _create_password_user(db_session)

    response = await client.post(
        "/auth/login",
        json={"username": user.username, "password": "s3cret-pass"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["user_id"] == str(user.id)
    assert data["username"] == user.username
    assert data["is_admin"] is False
    assert data["token_type"] == "bearer"

    claims = validate_app_token(data["access_token"])
    assert claims is not None
    assert claims["user_id"] == str(user.id)


@pytest.mark.asyncio
async def test_login_rejects_bad_password(client, db_session):
    user = await _create_password_user(db_session)

    response = await client.post(
        "/auth/login",
        json={"username": user.username, "password": "wrong-password"},
    )

    assert response.status_code == 401
    assert "Invalid username or password" in response.json()["detail"]


@pytest.mark.asyncio
async def test_login_rejects_unknown_user(client, db_session):
    response = await client.post(
        "/auth/login",
        json={"username": "ghost", "password": "s3cret-pass"},
    )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_refresh_issues_fresh_token(client, db_session):
    user = await _create_password_user(db_session)
    login = await client.post(
        "/auth/login",
        json={"username": user.username, "password": "s3cret-pass"},
    )
    session_token = login.json()["session_token"]

    response = await client.post(
        "/auth/refresh",
        json={"session_token": session_token},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["user_id"] == str(user.id)
    assert data["username"] == user.username
    assert data["is_admin"] is False

    claims = validate_app_token(data["access_token"])
    assert claims is not None
    assert claims["user_id"] == str(user.id)
    assert claims["exp"] > claims["iat"]


@pytest.mark.asyncio
async def test_refresh_requires_authentication(client, db_session):
    response = await client.post(
        "/auth/refresh",
        json={"session_token": "not-a-valid-session"},
    )

    assert response.status_code == 401


@pytest.mark.asyncio
async def test_me_returns_current_user(client, db_session):
    user = await _create_password_user(db_session)
    login = await client.post(
        "/auth/login",
        json={"username": user.username, "password": "s3cret-pass"},
    )
    token = login.json()["access_token"]

    response = await client.get(
        "/auth/me",
        headers={"Authorization": f"Bearer {token}"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["id"] == str(user.id)
    assert data["username"] == user.username


@pytest.mark.asyncio
async def test_me_requires_authentication(client, db_session):
    response = await client.get(
        "/auth/me",
        headers={"Authorization": "Bearer not-a-valid-token"},
    )

    assert response.status_code == 401
