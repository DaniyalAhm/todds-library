"""add end_position to chapters

Revision ID: 20260725_0004
Revises: 20260725_0003
Create Date: 2026-07-26
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260725_0004"
down_revision = "20260725_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "chapters" in table_names:
        columns = {column["name"] for column in inspector.get_columns("chapters")}
        if "end_position" not in columns:
            op.add_column("chapters", sa.Column("end_position", sa.Integer(), nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "chapters" in table_names:
        columns = {column["name"] for column in inspector.get_columns("chapters")}
        if "end_position" in columns:
            op.drop_column("chapters", "end_position")
