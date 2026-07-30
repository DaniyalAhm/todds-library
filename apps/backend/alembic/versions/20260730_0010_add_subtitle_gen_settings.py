"""add subtitle generation settings

Revision ID: 20260730_0010
Revises: 20260730_0009
Create Date: 2026-07-30
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20260730_0010"
down_revision = "20260730_0009"
branch_labels = None
depends_on = None


_SEED_DATA = {
    "subtitle_gen_mode": "manual",
    "auto_gen_language": "auto",
}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "system_settings" in table_names:
        for key, value in _SEED_DATA.items():
            bind.execute(
                sa.text(
                    "INSERT INTO system_settings (key, value) VALUES (:key, :value) ON CONFLICT (key) DO NOTHING"
                ),
                {"key": key, "value": value},
            )


def downgrade() -> None:
    bind = op.get_bind()
    for key in _SEED_DATA:
        bind.execute(
            sa.text("DELETE FROM system_settings WHERE key = :key"),
            {"key": key},
        )
