"""add generated_audio table

Revision ID: 20260726_0005
Revises: 20260725_0004
Create Date: 2026-07-26
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "20260726_0005"
down_revision = "20260725_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "generated_audio" not in table_names:
        op.create_table(
            "generated_audio",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, default=sa.text("gen_random_uuid()")),
            sa.Column("book_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("books.id"), nullable=False, index=True),
            sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False, index=True),
            sa.Column("chapter_index", sa.Integer(), nullable=False),
            sa.Column("voice_id", sa.String(255), nullable=False),
            sa.Column("file_path", sa.String(1024), nullable=False),
            sa.Column("duration", sa.Float(), nullable=True),
            sa.Column("status", sa.String(32), nullable=False, server_default="completed"),
            sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "generated_audio" in table_names:
        op.drop_table("generated_audio")
