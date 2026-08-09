"""float chapter positions and chapter-detection setting

Revision ID: 20260801_0013
Revises: 20260730_0012
Create Date: 2026-08-01
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260801_0013"
down_revision = "20260730_0012"
branch_labels = None
depends_on = None


def _chapters_columns(bind) -> dict[str, sa.Column]:
    inspector = sa.inspect(bind)
    if "chapters" not in inspector.get_table_names():
        return {}
    return {column["name"]: column for column in inspector.get_columns("chapters")}


def upgrade() -> None:
    bind = op.get_bind()

    columns = _chapters_columns(bind)
    if "start_position" in columns and isinstance(columns["start_position"]["type"], sa.Integer):
        op.alter_column(
            "chapters",
            "start_position",
            existing_type=sa.Integer(),
            type_=sa.Float(),
            existing_nullable=True,
        )
    if "end_position" in columns and isinstance(columns["end_position"]["type"], sa.Integer):
        op.alter_column(
            "chapters",
            "end_position",
            existing_type=sa.Integer(),
            type_=sa.Float(),
            existing_nullable=True,
        )

    inspector = sa.inspect(bind)
    if "system_settings" in inspector.get_table_names():
        bind.execute(
            sa.text(
                "INSERT INTO system_settings (key, value) VALUES (:key, :value) ON CONFLICT (key) DO NOTHING"
            ),
            {"key": "chapter_gap_threshold_sec", "value": "3.0"},
        )


def downgrade() -> None:
    bind = op.get_bind()

    columns = _chapters_columns(bind)
    if "start_position" in columns and isinstance(columns["start_position"]["type"], sa.Float):
        op.alter_column(
            "chapters",
            "start_position",
            existing_type=sa.Float(),
            type_=sa.Integer(),
            existing_nullable=True,
        )
    if "end_position" in columns and isinstance(columns["end_position"]["type"], sa.Float):
        op.alter_column(
            "chapters",
            "end_position",
            existing_type=sa.Float(),
            type_=sa.Integer(),
            existing_nullable=True,
        )

    bind = op.get_bind()
    bind.execute(
        sa.text("DELETE FROM system_settings WHERE key = :key"),
        {"key": "chapter_gap_threshold_sec"},
    )
