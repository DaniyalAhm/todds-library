from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    username: Mapped[str] = mapped_column(String(255), nullable=False, unique=True)
    email: Mapped[str] = mapped_column(String(255), nullable=False, default="")
    authentik_sub: Mapped[str | None] = mapped_column(
        String(255), unique=True, nullable=True, index=True, default=None
    )
    hashed_password: Mapped[str | None] = mapped_column(
        String(255), nullable=True, default=None
    )
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    libraries = relationship("Library", back_populates="user", lazy="selectin")
    reading_progress = relationship("ReadingProgress", back_populates="user", lazy="selectin")
    bookmarks = relationship("Bookmark", back_populates="user", lazy="selectin")
    generated_audios = relationship("GeneratedAudio", back_populates="user", lazy="selectin", cascade="all, delete-orphan")
