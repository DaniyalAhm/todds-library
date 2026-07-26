from __future__ import annotations

from uuid import UUID

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
