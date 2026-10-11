"""add completion + medium columns to reading_progress

Revision ID: 20260803_0016
Revises: 20260803_0015
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa

revision = "20260803_0016"
down_revision = "20260803_0015"
branch_labels = None
depends_on = None


_COLUMNS = [
    ("completed", sa.Boolean(), {"server_default": sa.false(), "nullable": False}),
    ("completed_at", sa.DateTime(timezone=True), {"nullable": True}),
    ("medium", sa.String(16), {"nullable": True}),
    ("completed_medium", sa.String(16), {"nullable": True}),
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "reading_progress" not in inspector.get_table_names():
        return
    existing = {c["name"] for c in inspector.get_columns("reading_progress")}
    for name, type_, kwargs in _COLUMNS:
        if name not in existing:
            op.add_column("reading_progress", sa.Column(name, type_, **kwargs))


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "reading_progress" not in inspector.get_table_names():
        return
    existing = {c["name"] for c in inspector.get_columns("reading_progress")}
    for name, _type_, _kwargs in reversed(_COLUMNS):
        if name in existing:
            op.drop_column("reading_progress", name)
