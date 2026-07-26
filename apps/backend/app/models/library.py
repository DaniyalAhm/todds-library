from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import DateTime, Enum, ForeignKey, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class LibraryType(str, enum.Enum):
    ebook = "ebook"
    audiobook = "audiobook"
    mixed = "mixed"


class Library(Base):
    __tablename__ = "libraries"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    path: Mapped[str] = mapped_column(String(1024), nullable=False)
    type: Mapped[LibraryType] = mapped_column(
        Enum(LibraryType, name="library_type"), nullable=False, default=LibraryType.mixed
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    user = relationship("User", back_populates="libraries", lazy="selectin")
    books = relationship("Book", back_populates="library", lazy="selectin", cascade="all, delete-orphan")

    @property
    def book_count(self) -> int:
        return len(self.books or [])
