"""use bigint for book file size

Revision ID: 20260725_0002
Revises: 20260725_0001
Create Date: 2026-07-25 23:45:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260725_0002"
down_revision = "20260725_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "books" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("books")}
    if "file_size" not in columns:
        return

    op.alter_column(
        "books",
        "file_size",
        existing_type=sa.Integer(),
        type_=sa.BigInteger(),
        existing_nullable=False,
        existing_server_default=None,
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "books" not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns("books")}
    if "file_size" not in columns:
        return

    op.alter_column(
        "books",
        "file_size",
        existing_type=sa.BigInteger(),
        type_=sa.Integer(),
        existing_nullable=False,
        existing_server_default=None,
    )
