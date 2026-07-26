"""add reader location fields

Revision ID: 20260725_0001
Revises:
Create Date: 2026-07-25
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260725_0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "reading_progress" in table_names:
        columns = {column["name"] for column in inspector.get_columns("reading_progress")}
        if "location" not in columns:
            op.add_column("reading_progress", sa.Column("location", sa.String(length=2048), nullable=True))

    if "bookmarks" in table_names:
        columns = {column["name"] for column in inspector.get_columns("bookmarks")}
        if "location" not in columns:
            op.add_column("bookmarks", sa.Column("location", sa.String(length=2048), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "bookmarks" in table_names:
        columns = {column["name"] for column in inspector.get_columns("bookmarks")}
        if "location" in columns:
            op.drop_column("bookmarks", "location")

    if "reading_progress" in table_names:
        columns = {column["name"] for column in inspector.get_columns("reading_progress")}
        if "location" in columns:
            op.drop_column("reading_progress", "location")
