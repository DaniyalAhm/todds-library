"""Track snapshot ordering and database save time for each user's position.

Revision ID: 20261011_0018
Revises: 20261011_0017
"""
from alembic import op
import sqlalchemy as sa

revision = '20261011_0018'
down_revision = '20261011_0017'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('reading_progress', sa.Column('captured_at', sa.BigInteger(), nullable=True))
    op.add_column('reading_progress', sa.Column('position_updated_at', sa.DateTime(timezone=True), nullable=True))
    op.execute('UPDATE reading_progress SET position_updated_at = last_updated')


def downgrade() -> None:
    op.drop_column('reading_progress', 'position_updated_at')
    op.drop_column('reading_progress', 'captured_at')
