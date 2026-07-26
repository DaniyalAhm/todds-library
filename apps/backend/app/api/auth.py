from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_current_user, get_db
from app.schemas.auth import AuthResponse, LoginRequest, RegisterRequest, SetupStatus, UserInfo
from app.services.auth_service import (
    authenticate_user,
    create_user_jwt,
    get_or_create_authentik_user,
    get_user_by_username,
    hash_password,
    validate_authentik_token,
)
from app.models.user import User

router = APIRouter()


async def has_users(db: AsyncSession) -> bool:
    result = await db.execute(select(User.id).limit(1))
    return result.scalar_one_or_none() is not None


@router.get("/setup/status", response_model=SetupStatus)
async def setup_status(db: AsyncSession = Depends(get_db)):
    return SetupStatus(needs_setup=not await has_users(db))


@router.post("/login", response_model=AuthResponse)
async def local_login(
    request: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    user = await authenticate_user(db, request.username, request.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    token = create_user_jwt(user)
    return AuthResponse(
        access_token=token,
        user_id=user.id,
        username=user.username,
        email=user.email,
        is_admin=user.is_admin,
    )


@router.post("/register", response_model=AuthResponse)
async def register(
    request: RegisterRequest,
    db: AsyncSession = Depends(get_db),
):
    existing = await get_user_by_username(db, request.username)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already taken",
        )
    if not request.username.strip() or len(request.password) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Username cannot be empty and password must be at least 4 characters",
        )
    first_user = not await has_users(db)
    if not first_user:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Initial setup is already complete",
        )

    user = User(
        username=request.username,
        hashed_password=hash_password(request.password),
        is_admin=first_user,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    token = create_user_jwt(user)
    return AuthResponse(
        access_token=token,
        user_id=user.id,
        username=user.username,
        email=user.email,
        is_admin=user.is_admin,
    )


@router.post("/authentik", response_model=AuthResponse)
async def authentik_login(
    request: LoginRequest,
    db: AsyncSession = Depends(get_db),
):
    if not settings.authentik_issuer:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Authentik is not configured",
        )
    claims = await validate_authentik_token(request.password)
    if claims is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token",
        )
    user = await get_or_create_authentik_user(db, claims)
    token = create_user_jwt(user)
    return AuthResponse(
        access_token=token,
        user_id=user.id,
        username=user.username,
        email=user.email,
        is_admin=user.is_admin,
    )


@router.post("/refresh", response_model=AuthResponse)
async def refresh_token(
    current_user: User = Depends(get_current_user),
):
    token = create_user_jwt(current_user)
    return AuthResponse(
        access_token=token,
        user_id=current_user.id,
        username=current_user.username,
        email=current_user.email,
        is_admin=current_user.is_admin,
    )


@router.get("/me", response_model=UserInfo)
async def get_me(
    current_user: User = Depends(get_current_user),
):
    return current_user
