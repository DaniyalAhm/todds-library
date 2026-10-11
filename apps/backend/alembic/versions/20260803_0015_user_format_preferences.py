"""add user_format_preferences for per-user reading format choice

Revision ID: 20260803_0015
Revises: 20260802_0014
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260803_0015"
down_revision = "20260802_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "user_format_preferences" in inspector.get_table_names():
        return
    op.create_table(
        "user_format_preferences",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("book_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("books.id"), nullable=False),
        sa.Column("format", sa.String(16), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("user_id", "book_id", name="uq_format_pref_user_book"),
    )
    op.create_index("ix_user_format_preferences_user_id", "user_format_preferences", ["user_id"])
    op.create_index("ix_user_format_preferences_book_id", "user_format_preferences", ["book_id"])


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "user_format_preferences" not in inspector.get_table_names():
        return
    try:
        op.drop_index("ix_user_format_preferences_book_id", table_name="user_format_preferences")
    except Exception:
        pass
    try:
        op.drop_index("ix_user_format_preferences_user_id", table_name="user_format_preferences")
    except Exception:
        pass
    op.drop_table("user_format_preferences")
