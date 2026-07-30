"""add system_settings table

Revision ID: 20260730_0009
Revises: 20260730_0008
Create Date: 2026-07-30
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20260730_0009"
down_revision = "20260730_0008"
branch_labels = None
depends_on = None


_SEED_DATA = {
    "asr_device": "auto",
    "asr_gpu_index": "0",
    "asr_compute_type": "float32",
    "asr_model_id": "small",
}


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "system_settings" not in table_names:
        op.create_table(
            "system_settings",
            sa.Column("key", sa.String(255), primary_key=True),
            sa.Column("value", sa.Text, nullable=False, server_default=""),
        )

        for key, value in _SEED_DATA.items():
            bind.execute(
                sa.text(
                    "INSERT INTO system_settings (key, value) VALUES (:key, :value) ON CONFLICT (key) DO NOTHING"
                ),
                {"key": key, "value": value},
            )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "system_settings" in table_names:
        op.drop_table("system_settings")
