"""add subtitle_metadata table

Revision ID: 20260730_0008
Revises: 20260727_0007
Create Date: 2026-07-30
"""

from __future__ import annotations

import json
from pathlib import Path

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "20260730_0008"
down_revision = "20260727_0007"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "subtitle_metadata" not in table_names:
        op.create_table(
            "subtitle_metadata",
            sa.Column(
                "id",
                postgresql.UUID(as_uuid=True),
                primary_key=True,
                default=sa.text("gen_random_uuid()"),
            ),
            sa.Column(
                "chapter_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("chapters.id"),
                unique=True,
                nullable=False,
                index=True,
            ),
            sa.Column(
                "book_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("books.id"),
                nullable=False,
                index=True,
            ),
            sa.Column("language", sa.String(16), nullable=True),
            sa.Column("model_id", sa.String(255), nullable=True),
            sa.Column(
                "status",
                sa.String(32),
                nullable=False,
                server_default="completed",
            ),
            sa.Column("json_path", sa.String(1024), nullable=True),
            sa.Column("srt_path", sa.String(1024), nullable=True),
            sa.Column("vtt_path", sa.String(1024), nullable=True),
            sa.Column("cue_count", sa.Integer(), nullable=True),
            sa.Column("word_count", sa.Integer(), nullable=True),
            sa.Column("duration_sec", sa.Float(), nullable=True),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
        )

    try:
        _backfill_existing_subtitles(bind)
    except Exception:
        pass


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    table_names = set(inspector.get_table_names())

    if "subtitle_metadata" in table_names:
        op.drop_table("subtitle_metadata")


def _backfill_existing_subtitles(bind) -> None:
    try:
        from app.config import settings

        books_dir = settings.books_dir
    except Exception:
        books_dir = "/books"

    subtitles_root = Path(books_dir) / "subtitles"
    if not subtitles_root.exists():
        return

    result = bind.execute(
        sa.text("SELECT id, book_id, \"index\" FROM chapters ORDER BY \"index\"")
    )
    chapters = result.fetchall()

    for row in chapters:
        chapter_id = str(row[0])
        book_id = str(row[1])
        idx = row[2] or 0

        json_path = subtitles_root / book_id / f"chapter_{idx:04d}.json"
        if not json_path.exists():
            continue

        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception:
            continue

        language = data.get("language", "en")
        cues = data.get("cues", [])
        cue_count = len(cues)
        word_count = sum(len(cue.get("words", [])) for cue in cues)
        duration_sec = max((cue.get("end", 0) for cue in cues), default=0.0)

        bind.execute(
            sa.text(
                """
                INSERT INTO subtitle_metadata
                    (chapter_id, book_id, language, status,
                     json_path, srt_path, vtt_path, cue_count, word_count, duration_sec)
                VALUES
                    (:chapter_id, :book_id, :language, 'completed',
                     :json_path, :srt_path, :vtt_path, :cue_count, :word_count, :duration_sec)
                ON CONFLICT (chapter_id) DO UPDATE SET
                    language = EXCLUDED.language,
                    json_path = EXCLUDED.json_path,
                    srt_path = EXCLUDED.srt_path,
                    vtt_path = EXCLUDED.vtt_path,
                    cue_count = EXCLUDED.cue_count,
                    word_count = EXCLUDED.word_count,
                    duration_sec = EXCLUDED.duration_sec
                """
            ),
            {
                "chapter_id": chapter_id,
                "book_id": book_id,
                "language": language,
                "json_path": str(json_path),
                "srt_path": str(json_path.with_suffix(".srt")),
                "vtt_path": str(json_path.with_suffix(".vtt")),
                "cue_count": cue_count,
                "word_count": word_count,
                "duration_sec": duration_sec,
            },
        )
