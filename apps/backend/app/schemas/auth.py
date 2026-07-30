from __future__ import annotations

from uuid import UUID

from datetime import datetime

from pydantic import BaseModel


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
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
