from __future__ import annotations

from uuid import UUID

from datetime import datetime

from pydantic import BaseModel, Field


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    playback_speed: float = 1.0
    session_token: str
    user_id: UUID
    username: str
    email: str
    is_admin: bool


class LoginRequest(BaseModel):
    username: str
    password: str


class RegisterRequest(BaseModel):
    username: str
    password: str


class RefreshRequest(BaseModel):
    session_token: str


class LogoutRequest(BaseModel):
    session_token: str


class SetupStatus(BaseModel):
    needs_setup: bool


class UserInfo(BaseModel):
    id: UUID
    username: str
    email: str
    is_admin: bool

    model_config = {"from_attributes": True}


class AdminUserInfo(UserInfo):
    authentik_sub: str | None = None
    has_password: bool
    created_at: datetime
    updated_at: datetime


class AdminUserList(BaseModel):
    items: list[AdminUserInfo]


class AdminUserCreate(BaseModel):
    username: str
    email: str = ""
    password: str
    is_admin: bool = False


class AdminUserUpdate(BaseModel):
    username: str | None = None
    email: str | None = None
    password: str | None = None
    is_admin: bool | None = None


class PlaybackSpeedRequest(BaseModel):
    session_token: str
    playback_speed: float | None = Field(default=None, ge=0.5, le=3.0, allow_inf_nan=False)


class PlaybackSpeedResponse(BaseModel):
    playback_speed: float
