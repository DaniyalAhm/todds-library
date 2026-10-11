from __future__ import annotations

import json

import pytest

from app.services.session_service import create_session, get_session


@pytest.mark.asyncio
async def test_speed_is_saved_per_user_and_carried_into_sessions(client, test_user, redis_client):
    session = await create_session(str(test_user.id))
    other = await create_session('another-user')
    sibling = await create_session(str(test_user.id))
    original_ttl = await redis_client.ttl(f'sess:{sibling}')

    initial = await client.post('/auth/session/playback-speed', json={'session_token': session})
    assert initial.json() == {'playback_speed': 1.0}
    saved = await client.post('/auth/session/playback-speed', json={'session_token': session, 'playback_speed': 1.75})
    assert saved.status_code == 200
    assert saved.json() == {'playback_speed': 1.75}
    assert await get_session(session) == str(test_user.id)
    assert json.loads(await redis_client.get(f'sess:{sibling}'))['playback_speed'] == 1.75
    assert await redis_client.ttl(f'sess:{sibling}') <= original_ttl

    isolated = await client.post('/auth/session/playback-speed', json={'session_token': other})
    assert isolated.json() == {'playback_speed': 1.0}
    new_session = await create_session(str(test_user.id))
    assert json.loads(await redis_client.get(f'sess:{new_session}'))['playback_speed'] == 1.75
    refreshed = await client.post('/auth/refresh', json={'session_token': session})
    assert refreshed.json()['playback_speed'] == 1.75


@pytest.mark.asyncio
@pytest.mark.parametrize('speed', [0.25, 3.5, 'NaN', 'Infinity'])
async def test_speed_rejects_invalid_values(client, test_user, speed):
    session = await create_session(str(test_user.id))
    response = await client.post('/auth/session/playback-speed', json={'session_token': session, 'playback_speed': speed})
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_speed_rejects_expired_sessions(client):
    response = await client.post('/auth/session/playback-speed', json={'session_token': 'expired', 'playback_speed': 2})
    assert response.status_code == 401
