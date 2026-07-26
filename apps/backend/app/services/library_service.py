from __future__ import annotations

from pathlib import Path
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.models.library import Library
from app.models.user import User
from app.schemas.library import LibraryCreate


def normalize_library_path(path: str) -> str:
    return str(Path(path).expanduser().resolve())


def validate_library_directory(path: str) -> str:
    normalized = normalize_library_path(path)
    if not Path(normalized).is_dir():
        raise ValueError("Library path must be an existing directory")
    return normalized


def get_library_root() -> Path:
    root = Path(settings.books_dir).expanduser().resolve()
    return root


def resolve_browsable_library_path(path: str | None = None) -> Path:
    root = get_library_root()
    if not root.is_dir():
        raise ValueError("Library root is not mounted or is not a directory")

    if not path:
        return root

    current = Path(path).expanduser().resolve()
    try:
        current.relative_to(root)
    except ValueError as exc:
        raise ValueError("Directory must be inside the configured library root") from exc

    if not current.is_dir():
        raise ValueError("Directory path must be an existing directory")

    return current


def list_library_directories(path: str | None = None) -> dict[str, object]:
    root = get_library_root()
    current = resolve_browsable_library_path(path)

    directories: list[dict[str, object]] = []
    for directory in sorted((item for item in current.iterdir() if item.is_dir()), key=lambda item: item.name.lower()):
        has_children = any(child.is_dir() for child in directory.iterdir())
        directories.append({
            "name": directory.name,
            "path": str(directory),
            "has_children": has_children,
        })

    parent = current.parent if current != root else None
    return {
        "root": str(root),
        "current": str(current),
        "parent": str(parent) if parent else None,
        "items": directories,
    }


async def create_library(db: AsyncSession, user: User, data: LibraryCreate) -> Library:
    path = validate_library_directory(data.path)
    existing = await db.execute(
        select(Library).where(Library.user_id == user.id, Library.path == path)
    )
    if existing.scalar_one_or_none() is not None:
        raise ValueError("Library path has already been added")
    library = Library(
        name=data.name,
        path=path,
        type=data.type,
        user_id=user.id,
    )
    db.add(library)
    await db.commit()
    await db.refresh(library)
    return library


async def get_libraries(db: AsyncSession, user: User) -> list[Library]:
    result = await db.execute(
        select(Library)
        .options(selectinload(Library.books))
        .where(Library.user_id == user.id)
        .order_by(Library.name)
    )
    return list(result.scalars().all())


async def get_library(db: AsyncSession, library_id: UUID, user: User) -> Library | None:
    result = await db.execute(
        select(Library).where(Library.id == library_id, Library.user_id == user.id)
        .options(selectinload(Library.books))
    )
    return result.scalar_one_or_none()


async def delete_library(db: AsyncSession, library_id: UUID, user: User) -> None:
    library = await get_library(db, library_id, user)
    if library:
        await db.delete(library)
        await db.commit()
