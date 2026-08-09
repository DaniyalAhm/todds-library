from __future__ import annotations

import pytest
from sqlalchemy import delete

from app.models.user import User
from app.services.auth_service import create_user_jwt, hash_password


@pytest.mark.asyncio
async def test_setup_status_requires_setup_when_no_users(client, db_session):
    await db_session.execute(delete(User))
    await db_session.commit()

    response = await client.get("/auth/setup/status")

    assert response.status_code == 200
    assert response.json() == {"needs_setup": True}


@pytest.mark.asyncio
async def test_register_creates_first_user_as_admin(client, db_session):
    await db_session.execute(delete(User))
    await db_session.commit()

    response = await client.post(
        "/auth/register",
        json={"username": "admin", "password": "secret"},
    )

    assert response.status_code == 200
    data = response.json()
    assert data["username"] == "admin"
    assert data["is_admin"] is True
    assert data["access_token"]
    assert data["session_token"]


@pytest.mark.asyncio
async def test_refresh_with_session_token_keeps_session(client, db_session):
    response = await client.post(
        "/auth/refresh",
        json={"session_token": "does-not-exist"},
    )
    assert response.status_code == 401

    user = User(
        username="refresh-user",
        hashed_password=hash_password("secret"),
        is_admin=False,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    login = await client.post(
        "/auth/login",
        json={"username": "refresh-user", "password": "secret"},
    )
    assert login.status_code == 200
    session_token = login.json()["session_token"]

    refresh = await client.post(
        "/auth/refresh",
        json={"session_token": session_token},
    )
    assert refresh.status_code == 200
    data = refresh.json()
    assert data["access_token"]
    assert data["user_id"] == str(user.id)
    assert data["session_token"] == session_token

    again = await client.post(
        "/auth/refresh",
        json={"session_token": session_token},
    )
    assert again.status_code == 200


@pytest.mark.asyncio
async def test_logout_revokes_session(client, db_session):
    user = User(
        username="logout-user",
        hashed_password=hash_password("secret"),
        is_admin=False,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)

    login = await client.post(
        "/auth/login",
        json={"username": "logout-user", "password": "secret"},
    )
    session_token = login.json()["session_token"]

    refresh = await client.post(
        "/auth/refresh",
        json={"session_token": session_token},
    )
    assert refresh.status_code == 200

    logout = await client.post(
        "/auth/logout",
        json={"session_token": session_token},
    )
    assert logout.status_code == 200

    after = await client.post(
        "/auth/refresh",
        json={"session_token": session_token},
    )
    assert after.status_code == 401


@pytest.mark.asyncio
async def test_register_is_forbidden_after_setup(client):
    response = await client.post(
        "/auth/register",
        json={"username": "second", "password": "secret"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Initial setup is already complete"}


@pytest.mark.asyncio
async def test_admin_can_create_and_list_users(client, db_session):
    admin = User(username="admin-users", hashed_password=hash_password("secret"), is_admin=True)
    db_session.add(admin)
    await db_session.commit()
    await db_session.refresh(admin)
    headers = {"Authorization": f"Bearer {create_user_jwt(admin)}"}

    response = await client.post(
        "/auth/users",
        headers=headers,
        json={
            "username": "reader",
            "email": "reader@example.test",
            "password": "secret",
            "is_admin": False,
        },
    )

    assert response.status_code == 201
    created = response.json()
    assert created["username"] == "reader"
    assert created["email"] == "reader@example.test"
    assert created["is_admin"] is False
    assert created["has_password"] is True

    list_response = await client.get("/auth/users", headers=headers)
    assert list_response.status_code == 200
    assert {user["username"] for user in list_response.json()["items"]} >= {"admin-users", "reader"}


@pytest.mark.asyncio
async def test_admin_cannot_remove_last_admin_role(client, db_session):
    await db_session.execute(delete(User))
    admin = User(username="only-admin", hashed_password=hash_password("secret"), is_admin=True)
    db_session.add(admin)
    await db_session.commit()
    await db_session.refresh(admin)
    headers = {"Authorization": f"Bearer {create_user_jwt(admin)}"}

    response = await client.patch(
        f"/auth/users/{admin.id}",
        headers=headers,
        json={"is_admin": False},
    )

    assert response.status_code == 409
    assert response.json() == {"detail": "Cannot remove the last admin"}


@pytest.mark.asyncio
async def test_admin_cannot_delete_self(client, db_session):
    admin = User(username="self-admin", hashed_password=hash_password("secret"), is_admin=True)
    db_session.add(admin)
    await db_session.commit()
    await db_session.refresh(admin)
    headers = {"Authorization": f"Bearer {create_user_jwt(admin)}"}

    response = await client.delete(f"/auth/users/{admin.id}", headers=headers)

    assert response.status_code == 409
    assert response.json() == {"detail": "Cannot delete your own account"}
