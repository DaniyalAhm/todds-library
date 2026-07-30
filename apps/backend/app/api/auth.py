from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from uuid import UUID

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.dependencies import get_current_user, get_db, require_admin
from app.schemas.auth import (
    AdminUserCreate,
    AdminUserInfo,
    AdminUserList,
    AdminUserUpdate,
    AuthResponse,
    LoginRequest,
    RegisterRequest,
    SetupStatus,
    UserInfo,
)
from app.services.auth_service import (
    authenticate_user,
    create_user_jwt,
    get_or_create_authentik_user,
    get_user_by_username,
    hash_password,
    validate_authentik_token,
)
from app.models.user import User
from app.models.bookmark import Bookmark
from app.models.library import Library
from app.models.progress import ReadingProgress

router = APIRouter()


async def has_users(db: AsyncSession) -> bool:
    result = await db.execute(select(User.id).limit(1))
    return result.scalar_one_or_none() is not None


def _admin_user_info(user: User) -> AdminUserInfo:
    return AdminUserInfo(
        id=user.id,
        username=user.username,
        email=user.email,
        is_admin=user.is_admin,
        authentik_sub=user.authentik_sub,
        has_password=bool(user.hashed_password),
        created_at=user.created_at,
        updated_at=user.updated_at,
    )


async def _admin_count(db: AsyncSession) -> int:
    result = await db.execute(select(func.count(User.id)).where(User.is_admin.is_(True)))
    return int(result.scalar_one())


async def _ensure_username_available(
    db: AsyncSession,
    username: str,
    *,
    exclude_user_id: UUID | None = None,
) -> None:
    result = await db.execute(select(User).where(User.username == username))
    existing = result.scalar_one_or_none()
    if existing is not None and existing.id != exclude_user_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already taken",
        )


def _clean_username(username: str | None) -> str | None:
    if username is None:
        return None
    cleaned = username.strip()
    if not cleaned:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Username cannot be empty",
        )
    return cleaned


def _clean_password(password: str | None, *, required: bool = False) -> str | None:
    if password is None:
        if required:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Password is required",
            )
        return None
    if len(password) < 4:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Password must be at least 4 characters",
        )
    return password


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


@router.get("/users", response_model=AdminUserList)
async def list_users(
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(User).order_by(User.created_at.desc(), User.username))
    users = result.scalars().all()
    return AdminUserList(items=[_admin_user_info(user) for user in users])


@router.post("/users", response_model=AdminUserInfo, status_code=status.HTTP_201_CREATED)
async def create_user(
    request: AdminUserCreate,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    username = _clean_username(request.username)
    password = _clean_password(request.password, required=True)
    await _ensure_username_available(db, username)

    user = User(
        username=username,
        email=request.email.strip(),
        hashed_password=hash_password(password),
        is_admin=request.is_admin,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return _admin_user_info(user)


@router.patch("/users/{user_id}", response_model=AdminUserInfo)
async def update_user(
    user_id: UUID,
    request: AdminUserUpdate,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    username = _clean_username(request.username)
    if username is not None and username != user.username:
        await _ensure_username_available(db, username, exclude_user_id=user.id)
        user.username = username

    if request.email is not None:
        user.email = request.email.strip()

    password = _clean_password(request.password)
    if password is not None:
        user.hashed_password = hash_password(password)

    if request.is_admin is not None and request.is_admin != user.is_admin:
        if user.is_admin and not request.is_admin and await _admin_count(db) <= 1:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Cannot remove the last admin",
            )
        user.is_admin = request.is_admin

    await db.commit()
    await db.refresh(user)
    return _admin_user_info(user)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: UUID,
    current_user: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    if user.id == current_user.id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete your own account",
        )
    if user.is_admin and await _admin_count(db) <= 1:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete the last admin",
        )

    library_count_result = await db.execute(
        select(func.count(Library.id)).where(Library.user_id == user.id)
    )
    if int(library_count_result.scalar_one()) > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Cannot delete a user who owns libraries",
        )

    await db.execute(delete(ReadingProgress).where(ReadingProgress.user_id == user.id))
    await db.execute(delete(Bookmark).where(Bookmark.user_id == user.id))
    await db.delete(user)
    await db.commit()
