from __future__ import annotations

import time
from datetime import datetime, timedelta
from uuid import UUID

import httpx
from jose import JWTError, jwk, jwt
from jose.constants import Algorithms
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.user import User

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

_jwks_cache: dict | None = None
_jwks_cache_time: float = 0
JWKS_CACHE_TTL = 300


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str | None) -> bool:
    if hashed_password is None:
        return False
    return pwd_context.verify(plain_password, hashed_password)


async def fetch_jwks() -> dict | None:
    global _jwks_cache, _jwks_cache_time
    now = time.time()
    if _jwks_cache is not None and (now - _jwks_cache_time) < JWKS_CACHE_TTL:
        return _jwks_cache
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(f"{settings.authentik_issuer}/.well-known/jwks")
            if resp.status_code == 200:
                _jwks_cache = resp.json()
                _jwks_cache_time = now
                return _jwks_cache
    except Exception:
        pass
    return None


def _get_public_key(jwks_data: dict, kid: str | None) -> dict | None:
    for key in jwks_data.get("keys", []):
        if kid is None or key.get("kid") == kid:
            return key
    return None


def validate_app_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(
            token,
            settings.secret_key,
            algorithms=[Algorithms.HS256],
        )
        return payload
    except JWTError:
        return None


async def validate_authentik_token(token: str) -> dict | None:
    if not settings.authentik_issuer:
        return None
    try:
        unverified_header = jwt.get_unverified_header(token)
    except JWTError:
        return None
    jwks_data = await fetch_jwks()
    if jwks_data is None:
        return None
    public_key_data = _get_public_key(jwks_data, unverified_header.get("kid"))
    if public_key_data is None:
        return None
    try:
        public_key = jwk.construct(public_key_data)
        payload = jwt.decode(
            token,
            public_key,
            algorithms=[Algorithms.RS256],
            audience=settings.authentik_client_id,
            issuer=settings.authentik_issuer,
        )
        return payload
    except JWTError:
        return None


def create_app_claims(user: User) -> dict:
    return {
        "sub": str(user.id),
        "user_id": str(user.id),
        "username": user.username,
        "email": user.email,
        "is_admin": user.is_admin,
    }


def create_user_jwt(user: User) -> str:
    claims = create_app_claims(user)
    claims["exp"] = datetime.utcnow() + timedelta(hours=24)
    claims["iat"] = datetime.utcnow()
    return jwt.encode(claims, settings.secret_key, algorithm=Algorithms.HS256)


async def get_user_by_username(db: AsyncSession, username: str) -> User | None:
    result = await db.execute(
        select(User).where(User.username == username)
    )
    return result.scalar_one_or_none()


async def get_user_by_id(db: AsyncSession, user_id: UUID) -> User | None:
    return await db.get(User, user_id)


async def authenticate_user(db: AsyncSession, username: str, password: str) -> User | None:
    user = await get_user_by_username(db, username)
    if user is None:
        return None
    if not verify_password(password, user.hashed_password):
        return None
    return user


async def get_or_create_authentik_user(db: AsyncSession, claims: dict) -> User:
    authentik_sub = claims.get("sub")
    if authentik_sub is None:
        raise ValueError("No sub claim in token")
    result = await db.execute(
        select(User).where(User.authentik_sub == str(authentik_sub))
    )
    user = result.scalar_one_or_none()
    if user is None:
        user = User(
            authentik_sub=str(authentik_sub),
            username=claims.get("preferred_username", claims.get("username", "unknown")),
            email=claims.get("email", ""),
            is_admin=claims.get("is_admin", False),
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    else:
        needs_update = False
        new_username = claims.get("preferred_username", claims.get("username"))
        new_email = claims.get("email")
        if new_username and user.username != new_username:
            user.username = new_username
            needs_update = True
        if new_email and user.email != new_email:
            user.email = new_email
            needs_update = True
        if needs_update:
            await db.commit()
            await db.refresh(user)
    return user
