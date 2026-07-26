from __future__ import annotations

import pytest
from sqlalchemy import delete

from app.models.user import User


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


@pytest.mark.asyncio
async def test_register_is_forbidden_after_setup(client):
    response = await client.post(
        "/auth/register",
        json={"username": "second", "password": "secret"},
    )

    assert response.status_code == 403
    assert response.json() == {"detail": "Initial setup is already complete"}
