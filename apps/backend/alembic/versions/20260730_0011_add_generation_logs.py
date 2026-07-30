"""add generation_logs table

Revision ID: 20260730_0011
Revises: 20260730_0010
Create Date: 2026-07-30
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "20260730_0011"
down_revision = "20260730_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "generation_logs" not in table_names:
        op.create_table(
            "generation_logs",
            sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
            sa.Column("book_id", UUID(as_uuid=True), sa.ForeignKey("books.id"), nullable=True, index=True),
            sa.Column("chapter_id", UUID(as_uuid=True), sa.ForeignKey("chapters.id"), nullable=True, index=True),
            sa.Column("chapter_index", sa.Integer, nullable=True),
            sa.Column("book_title", sa.String(512), nullable=True),
            sa.Column("status", sa.String(32), nullable=False, index=True),
            sa.Column("message", sa.Text, nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False, index=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "generation_logs" in table_names:
        op.drop_table("generation_logs")
