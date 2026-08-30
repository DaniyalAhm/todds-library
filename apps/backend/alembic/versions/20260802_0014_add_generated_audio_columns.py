"""add generated_audio columns for castwright (status extensions + chapter_id + models)

Revision ID: 20260802_0014
Revises: 20260801_0013
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260802_0014"
down_revision = "20260801_0013"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    cols = {c["name"] for c in inspector.get_columns("generated_audio")} if "generated_audio" in inspector.get_table_names() else set()
    if "generated_audio" not in inspector.get_table_names():
        # table missing (fresh env older than 20260726_0005) -> created by earlier migration
        return
    if "chapter_id" not in cols:
        op.add_column("generated_audio", sa.Column("chapter_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("chapters.id", ondelete="SET NULL"), nullable=True))
        op.create_index("ix_generated_audio_chapter_id", "generated_audio", ["chapter_id"])
    if "castwright_book_id" not in cols:
        op.add_column("generated_audio", sa.Column("castwright_book_id", sa.String(255), nullable=True))
    if "ollama_model" not in cols:
        op.add_column("generated_audio", sa.Column("ollama_model", sa.String(255), nullable=True))
    if "tts_model_key" not in cols:
        op.add_column("generated_audio", sa.Column("tts_model_key", sa.String(255), nullable=True))
    if "updated_at" not in cols:
        op.add_column("generated_audio", sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "generated_audio" not in inspector.get_table_names():
        return
    cols = {c["name"] for c in inspector.get_columns("generated_audio")}
    for col, idx in [
        ("updated_at", None),
        ("tts_model_key", None),
        ("ollama_model", None),
        ("castwright_book_id", None),
        ("chapter_id", "ix_generated_audio_chapter_id"),
    ]:
        if col in cols:
            if idx:
                try:
                    op.drop_index(idx, table_name="generated_audio")
                except Exception:
                    pass
            op.drop_column("generated_audio", col)
