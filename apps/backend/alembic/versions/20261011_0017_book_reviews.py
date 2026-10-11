"""Add personal ratings and reviews to reading progress.

Revision ID: 20261011_0017
Revises: 20260803_0016
"""
from alembic import op
import sqlalchemy as sa

revision = '20261011_0017'
down_revision = '20260803_0016'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('reading_progress', sa.Column('rating', sa.Integer(), nullable=True))
    op.add_column('reading_progress', sa.Column('review_text', sa.Text(), nullable=True))
    op.add_column('reading_progress', sa.Column('review_updated_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column('reading_progress', 'review_updated_at')
    op.drop_column('reading_progress', 'review_text')
    op.drop_column('reading_progress', 'rating')
