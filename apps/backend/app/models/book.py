from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, Float, ForeignKey, Integer, JSON, String, Text, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base


class BookFormat(str, enum.Enum):
    epub = "epub"
    pdf = "pdf"
    mobi = "mobi"
    cbz = "cbz"
    cbr = "cbr"
    mp3 = "mp3"
    m4b = "m4b"
    flac = "flac"
    ogg = "ogg"
    aac = "aac"
    wma = "wma"
    unknown = "unknown"


EBOOK_FORMAT_VALUES = {"epub", "pdf", "mobi", "cbz", "cbr"}
AUDIOBOOK_FORMAT_VALUES = {"mp3", "m4b", "flac", "ogg", "aac", "wma"}


class Book(Base):
    __tablename__ = "books"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    library_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("libraries.id"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(512), nullable=False, index=True)
    author: Mapped[str | None] = mapped_column(String(512), nullable=True, index=True)
    series: Mapped[str | None] = mapped_column(String(512), nullable=True)
    series_index: Mapped[float | None] = mapped_column(Float, nullable=True)
    isbn: Mapped[str | None] = mapped_column(String(32), nullable=True)
    asin: Mapped[str | None] = mapped_column(String(32), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    publisher: Mapped[str | None] = mapped_column(String(255), nullable=True)
    published_date: Mapped[str | None] = mapped_column(String(32), nullable=True)
    language: Mapped[str | None] = mapped_column(String(16), nullable=True)
    page_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    file_path: Mapped[str] = mapped_column(String(1024), nullable=False)
    file_format: Mapped[BookFormat] = mapped_column(
        Enum(BookFormat, name="book_format"), nullable=False, default=BookFormat.unknown
    )
    file_size: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    cover_path: Mapped[str | None] = mapped_column(String(1024), nullable=True)
    file_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)
    extra_metadata: Mapped[dict | None] = mapped_column("metadata", JSON, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    library = relationship("Library", back_populates="books", lazy="selectin")
    chapters = relationship("Chapter", back_populates="book", lazy="selectin", cascade="all, delete-orphan")
    reading_progress = relationship("ReadingProgress", back_populates="book", lazy="selectin")
    bookmarks = relationship("Bookmark", back_populates="book", lazy="selectin")
    metadata_caches = relationship("MetadataCache", back_populates="book", lazy="selectin")

    @property
    def has_ebook(self) -> bool:
        metadata = self.extra_metadata or {}
        return self.file_format.value in EBOOK_FORMAT_VALUES or bool(metadata.get("ebook_path"))

    @property
    def has_audiobook(self) -> bool:
        metadata = self.extra_metadata or {}
        return self.file_format.value in AUDIOBOOK_FORMAT_VALUES or bool(
            metadata.get("audiobook_path") or metadata.get("audio_files")
        )

    @property
    def ebook_format(self) -> str | None:
        metadata = self.extra_metadata or {}
        if metadata.get("ebook_format"):
            return str(metadata["ebook_format"])
        if self.file_format.value in EBOOK_FORMAT_VALUES:
            return self.file_format.value
        return None

    @property
    def audiobook_format(self) -> str | None:
        metadata = self.extra_metadata or {}
        if metadata.get("audiobook_format"):
            return str(metadata["audiobook_format"])
        if self.file_format.value in AUDIOBOOK_FORMAT_VALUES:
            return self.file_format.value
        return None

    @property
    def audio_track_count(self) -> int:
        metadata = self.extra_metadata or {}
        audio_files = metadata.get("audio_files")
        if isinstance(audio_files, list):
            return len([path for path in audio_files if isinstance(path, str)])
        if metadata.get("audiobook_path") or self.file_format.value in AUDIOBOOK_FORMAT_VALUES:
            return 1
        return 0
