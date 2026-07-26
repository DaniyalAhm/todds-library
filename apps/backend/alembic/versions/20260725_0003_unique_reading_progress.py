"""add unique user book reading progress

Revision ID: 20260725_0003
Revises: 20260725_0002
Create Date: 2026-07-25 23:55:00.000000
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260725_0003"
down_revision = "20260725_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "reading_progress" not in inspector.get_table_names():
        return

    constraints = {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("reading_progress")
    }
    if "uq_reading_progress_user_book" in constraints:
        return

    op.execute(
        sa.text(
            """
            DELETE FROM reading_progress
            WHERE id IN (
                SELECT id
                FROM (
                    SELECT
                        id,
                        row_number() OVER (
                            PARTITION BY user_id, book_id
                            ORDER BY last_updated DESC, id DESC
                        ) AS row_number
                    FROM reading_progress
                ) ranked
                WHERE ranked.row_number > 1
            )
            """
        )
    )
    op.create_unique_constraint(
        "uq_reading_progress_user_book",
        "reading_progress",
        ["user_id", "book_id"],
    )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if "reading_progress" not in inspector.get_table_names():
        return

    constraints = {
        constraint["name"]
        for constraint in inspector.get_unique_constraints("reading_progress")
    }
    if "uq_reading_progress_user_book" in constraints:
        op.drop_constraint(
            "uq_reading_progress_user_book",
            "reading_progress",
            type_="unique",
        )
