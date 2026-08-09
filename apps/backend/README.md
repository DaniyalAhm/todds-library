# Todds Library Backend

> Python 3.12 / FastAPI service for the Todds Library ebook & audiobook server.

Serves the REST API, runs the library scanner, transcodes audiobooks to HLS, enriches metadata, and powers the Faster-Whisper ASR subsystem (word-level subtitles + chapter detection).

- **API base path:** `/api` (Swagger docs at `/api/docs`, liveness probe at `/health`)
- **Async stack:** FastAPI + uvicorn, SQLAlchemy 2.0 async + asyncpg, Redis (sessions), Meilisearch (search)
- **Entry point:** `entrypoint.py` → `app.main:app`

## Table of contents

- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Project layout](#project-layout)
- [Authentication & authorization](#authentication--authorization)
- [API reference](#api-reference)
- [Data models](#data-models)
- [Scanner pipeline](#scanner-pipeline)
- [Metadata providers](#metadata-providers)
- [ASR / subtitle subsystem](#asr--subtitle-subsystem)
- [HLS transcoding](#hls-transcoding)
- [Database migrations](#database-migrations)
- [Testing](#testing)

## Quick start

```bash
cd apps/backend
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"

# run local Postgres/Redis/Meilisearch, or from the repo root:
docker compose up -d postgres redis meilisearch

alembic upgrade head
uvicorn app.main:app --reload --host 0.0.0.0 --port 8830
```

See the [root README](../README.md#development) for the Makefile-driven workflow (`make dev-backend`, `make bootstrap`).

## Configuration

Settings come from environment variables / a `.env` file (see `app/config.py`, `class Settings`).

| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | asyncpg URL | `postgresql+asyncpg://todds:todds_secret@localhost:5432/todds_library` |
| `REDIS_URL` | Redis URL | `redis://localhost:6379/0` |
| `MEILI_URL` | Meilisearch URL | `http://localhost:7700` |
| `MEILI_MASTER_KEY` | Meilisearch master key | empty |
| `AUTHENTIK_ISSUER` / `_CLIENT_ID` / `_CLIENT_SECRET` | Authentik OIDC | empty |
| `RREADING_GLASSES_URL` | Goodreads metadata mirror | empty |
| `ACCESS_TOKEN_TTL` | JWT lifetime (minutes) | `60` |
| `SESSION_TTL_DAYS` | Redis session TTL | `30` |
| `BOOKS_DIR` | Root books mount (`/books`) | `/books` |
| `COVERS_DIR` | Cover art + cache dir | `/data/covers` |
| `SECRET_KEY` | JWT signing secret | `change-me-to-a-real-secret` |
| `CORS_ORIGINS` | Allowed origins (JSON list) | `["http://localhost:3000"]` |
| `ASR_MODEL_ID` | Whisper model id | `small` |
| `ASR_MODELS_DIR` | Model cache dir | `/data/asr_models` |
| `ASR_DEVICE` | `auto` / `cuda` / `cpu` | `auto` |
| `ASR_GPU_INDEX` | CUDA device index | `0` |
| `ASR_COMPUTE_TYPE` | `float32` / `float16` | `float32` |
| `SUBTITLE_GEN_MODE` | `manual` / `auto_new` / `auto_all` | `manual` |
| `AUTO_GEN_LANGUAGE` | Whisper language hint | `auto` |
| `BATCH_SIZE` | Whisper batch size | `1` |
| `CHUNK_LENGTH_S` | Whisper chunk length | `30` |
| `VAD_FILTER` | Voice-activity-detection filter | `false` |

On startup the app runs Alembic migrations (`upgrade head`), ensures tables exist, initializes Redis, ensures the Meilisearch index exists, and marks interrupted generation logs as failed (`recover_interrupted_generation_logs`).

## Project layout

```
app/
├── main.py              # create_app(), lifespan (db init, redis, migrations, log recovery)
├── config.py            # pydantic-settings Settings
├── database.py          # async engine, session factory, Base
├── dependencies.py      # get_db, get_current_user, get_current_user_from_request, require_admin
├── api/
│   ├── router.py        # aggregates all routers under /api
│   ├── auth.py          # setup, login/register, authentik, refresh, users (admin)
│   ├── libraries.py     # CRUD + scan + directory browser + auto-gen hooks
│   ├── books.py         # list/detail/cover/download/progress/bookmarks
│   ├── audiobooks.py    # download, HLS stream + segments, cover
│   ├── search.py        # Meilisearch with SQL fallback
│   ├── metadata.py      # refresh / lookup / apply / update (admin)
│   ├── asr.py           # transcribe chapter, fetch subtitles
│   ├── generate.py      # per-book subtitle/chapter generation
│   └── settings.py      # ASR settings, bulk generation, generation logs
├── models/              # SQLAlchemy ORM models
├── schemas/             # Pydantic request/response models
├── services/            # scanner, book, library, search, metadata, auth, session, ASR, chapter, audiobook
├── scanner/             # file_parser, epub_parser, pdf_parser, cbz_parser, audio_parser
├── metadata/            # openlibrary, google_books, audible, isbndb, rreading_glasses
└── transcoder/          # ffmpeg HLS transcoding
```

## Authentication & authorization

- **Access token** — short-lived HS256 JWT signed with `SECRET_KEY`, sent as `Authorization: Bearer <token>`.
- **Session token** — opaque random token stored in Redis (`sess:<token>` → `{user_id}`) with a 30-day sliding TTL; exchanged for a fresh access token via `POST /auth/refresh`.
- **Media requests** — `/cover`, `/download`, `/stream` also accept the token as `?access_token=<token>` so `<img>`/`<audio>` tags can authenticate (`get_current_user_from_request`).
- **Admin guard** — `require_admin` dependency on library management, metadata, settings, and user administration.
- **First user wins** — `POST /auth/register` only succeeds before any user exists; that first user is made admin.
- **Authentik OIDC** — when `AUTHENTIK_ISSUER` is set, `POST /auth/authentik` validates the ID token against the issuer's JWKS and creates/updates a local user keyed on `sub`.

## API reference

All routes are prefixed with `/api`. Auth column: **Bearer** = JWT; `[admin]` = `require_admin`; `[media]` = also accepts `?access_token=`.

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | — | Liveness probe (`{"status": "healthy"}`) |

### Auth (`/auth`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/auth/setup/status` | — | `{ "needs_setup": bool }` — true when no users exist |
| POST | `/auth/login` | — | Local login → `AuthResponse` (access + session token) |
| POST | `/auth/register` | — | First-run admin registration (403 if setup complete) |
| POST | `/auth/authentik` | — | Exchange Authentik ID token (sent as `password`) for a local session |
| POST | `/auth/refresh` | — | Swap `session_token` for a fresh `AuthResponse` |
| POST | `/auth/logout` | — | Revoke the session token |
| GET | `/auth/me` | Bearer | Current user profile |
| GET | `/auth/users` | [admin] | List all users |
| POST | `/auth/users` | [admin] | Create user (username, email, password, `is_admin`) |
| PATCH | `/auth/users/{user_id}` | [admin] | Update user (guards removing the last admin) |
| DELETE | `/auth/users/{user_id}` | [admin] | Delete user (guards self / last admin / library owners) |

### Libraries (`/libraries`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/libraries` | Bearer | Libraries owned by the current user |
| GET | `/libraries/directories?path=` | [admin] | Browse the server filesystem for the directory picker |
| POST | `/libraries` | [admin] | Create library (name, path, type) **and scan it immediately** |
| GET | `/libraries/{library_id}` | Bearer | Library detail (incl. `book_count`) |
| DELETE | `/libraries/{library_id}` | [admin] | Delete library and its books |
| POST | `/libraries/{library_id}/scan` | [admin] | Scan for new/updated/removed books; returns counts. Kicks off auto subtitle generation when `subtitle_gen_mode` is `auto_new`/`auto_all` |

### Books (`/books`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/books` | Bearer | List books — query params: `library_id`, `search`, `author`, `series`, `format`, `sort`, `order`, `limit` (≤200), `offset` |
| GET | `/books/{book_id}` | Bearer | Book detail (chapters, progress, bookmarks, media flags) |
| GET | `/books/{book_id}/cover` | [media] | Cover image (`image/jpeg`) |
| GET | `/books/{book_id}/download` | [media] | Download the ebook file (MIME chosen by format) |
| POST | `/books/{book_id}/progress` | Bearer | Save reading progress `{ position, progress, location }` |
| GET | `/books/{book_id}/progress` | Bearer | Fetch the user's reading progress |
| POST | `/books/{book_id}/bookmarks` | Bearer | Create bookmark `{ position, location, note }` → 201 |
| GET | `/books/{book_id}/bookmarks` | Bearer | List bookmarks |
| DELETE | `/books/{book_id}/bookmarks/{bookmark_id}` | Bearer | Delete bookmark → 204 |

### Audiobooks (`/audiobooks`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/audiobooks/{book_id}/download?track=N` | [media] | Download an audio track (index 0 = first for multi-track books). Zero-padded corrupt audio is sanitized via ffmpeg into a cached MP3 |
| GET | `/audiobooks/{book_id}/stream` | [media] | Lazy-transcode to HLS and return the `.m3u8` playlist (segment URLs rewritten with the access token) |
| GET | `/audiobooks/{book_id}/stream/{segment}` | [media] | Serve a transcoded `.ts` segment (path-traversal guarded) |
| GET | `/audiobooks/{book_id}/cover` | [media] | Audiobook cover (`image/jpeg`) |

### Search (`/search`)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/search?q=&type=&limit=&offset=` | Bearer | Full-text search across the user's libraries. `type`: `all`/`ebook`/`audiobook`. Falls back to SQL when Meilisearch errors (`used_fallback` flag) |

### Metadata (`/metadata` — all admin)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/metadata/refresh/{book_id}` | [admin] | Enrich a single book from all providers (uses caches) and reindex |
| POST | `/metadata/refresh/library/{library_id}` | [admin] | Enrich every book in a library; returns a count |
| GET | `/metadata/lookup/{book_id}?title=&author=&isbn=&asin=&refresh=` | [admin] | Look up candidates from all providers (cached unless `refresh=true`) |
| POST | `/metadata/apply/{book_id}` | [admin] | Apply a metadata payload (overwrites fields + cover, matches Audible chapters) |
| PUT | `/metadata/{book_id}` | [admin] | Manually update book fields |

### ASR (routed at root)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/books/{book_id}/chapters/{chapter_id}/transcribe?overwrite=` | Bearer | Transcribe one chapter. 409 if subtitles exist (unless `overwrite=true`, which requires admin). Writes SRT/VTT/JSON |
| GET | `/books/{book_id}/chapters/{chapter_id}/subtitles?format=srt\|vtt\|json` | Bearer | Fetch subtitles (word-timed JSON preferred by the player) |

### Generate (routed at root)

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/books/{book_id}/chapters/{chapter_id}/generate/subtitles?overwrite=` | Bearer | Generate subtitles for one chapter (admin required for `overwrite=true`) |
| POST | `/books/{book_id}/generate/subtitles` | Bearer | Generate for a whole book; body `{ chapter_ids?, overwrite? }`. Returns per-chapter results |
| GET | `/books/{book_id}/generate/subtitles/status` | Bearer | List `chapter_*.srt` files already generated for a book |
| POST | `/books/{book_id}/generate/chapters` | Bearer | Auto-detect chapters from silence gaps. Body `{ overwrite?, gap_threshold_sec? }`. 409 for multi-track books |

### Settings (`/settings` — all admin)

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/settings` | [admin] | Current ASR settings + GPU status (devices, driver) |
| PUT | `/settings` | [admin] | Update settings (validates model/device/compute/mode/batch/chunk/VAD/gap values) |
| POST | `/settings/generate-all-subtitles` | [admin] | Background bulk subtitle generation across all audiobooks |
| POST | `/settings/generate-all-chapters` | [admin] | Background bulk chapter detection |
| POST | `/settings/cancel-generation` | [admin] | Cancel a running bulk/auto job after the current chapter |
| GET | `/settings/generation-logs?limit=` | [admin] | `{ running, logs: [...] }` — live generation status (polled by the UI every 3s) |

## Data models

ORM models in `app/models/` (SQLAlchemy 2.0, PostgreSQL UUID primary keys):

| Model | Table | Notes |
|---|---|---|
| `User` | `users` | username (unique), email, `authentik_sub`, bcrypt `hashed_password`, `is_admin` |
| `Library` | `libraries` | name, path, type (`ebook`/`audiobook`/`mixed`), owner `user_id` |
| `Book` | `books` | title/author/series/index/isbn/asin, description, publisher, `file_path`, `file_format` (enum), `file_size`, `cover_path`, `file_hash` (sha256), `extra_metadata` (JSON: ebook/audio paths, formats, `audio_files[]`); computed `has_ebook`/`has_audiobook`/`audio_track_count` |
| `Chapter` | `chapters` | `index`, `title`, `start_position`, `end_position` (seconds) |
| `ReadingProgress` | `reading_progress` | unique `(user_id, book_id)`, `position`, `location` (epub CFI), `progress` (0–1) |
| `Bookmark` | `bookmarks` | `position`, `location`, `note` |
| `SubtitleMetadata` | `subtitle_metadata` | per chapter: language, `model_id`, `json_path`/`srt_path`/`vtt_path`, `cue_count`, `word_count`, `duration_sec`, `status` |
| `MetadataCache` | `metadata_cache` | per-book per-source cached provider payload |
| `GenerationLog` | `generation_logs` | book/chapter, `status`, `message`, timestamps |
| `SystemSetting` | `system_settings` | key/value store for runtime ASR settings |

## Scanner pipeline

`services/scanner_service.py` walks a library directory and:

1. **Classifies** files by extension (`classify_file` in `scanner/file_parser.py`).
2. **Parses filenames** — supports `Author - Title.ext`, `Series #1 - Title.ext`, and folder layouts (`Author/Title/`, `Author/Title/Chapters/`).
3. **Groups multi-track audio** in the same folder into one audiobook (`audio_files[]`), sorted naturally.
4. **Merges ebook + audiobook** pairs in the same folder into one dual-format book with a combined content hash.
5. **Diffs against existing rows** by hash — inserts new, updates changed, removes deleted (counts + ids returned).
6. **Enriches metadata** (async, via providers) and **indexes** the book into Meilisearch.
7. **Optional auto-generation** — if the runtime mode is `auto_new`/`auto_all`, subtitle generation is queued as a background task for new/updated audiobooks.

Individual file parsing lives in `app/scanner/`: `epub_parser.py` (ebooklib), `pdf_parser.py` (PyMuPDF), `cbz_parser.py`, and `audio_parser.py` (mutagen tags → title/author/duration/tracks).

## Metadata providers

`app/metadata/` implements a common `fetch()` contract; `services/metadata_service.py` orchestrates them, caches results per source, merges best-effort, downloads covers, and matches Audible chapter titles to existing chapter rows.

| Provider | Lookup keys | Notes |
|---|---|---|
| `rreading_glasses` | Goodreads mirror (title/author) | `blampe/rreading-glasses`; needs `RREADING_GLASSES_URL` |
| `openlibrary` | ISBN / title / author | Covers + identifiers |
| `google_books` | ISBN / title / author | Description, publisher, pages |
| `audible` | ASIN / title / author | Duration + **chapter list** (matched to book chapters) |
| `isbndb` | ISBN | Covers + metadata |

Lookups are cached in `MetadataCache`; cache entries with a missing cover are invalidated on refresh.

## ASR / subtitle subsystem

See also the [root README's ASR section](../README.md#ai--asr-subsystem). Implementation notes:

- **`services/asr_service.py`** — model-id normalization (`openai/whisper-*` aliases → `tiny`…`turbo`), model pipeline caching, compute-type/device resolution, chunked transcription with resume-from-partials + timestamp offset stitching, ffmpeg fallback for undecodable/zero-padded audio, and SRT/VTT/JSON serialization.
- **`services/chapter_service.py`** — splits whisper segments into chapters at silence gaps (`gap_threshold_sec`, default 3.0s), generates titles from the first sentence, reuses existing subtitle timestamps to avoid re-transcription, and applies chapters to the book.
- **`GenerationLog`** rows stream status with 30-second heartbeats (`_run_with_transcription_heartbeats`) so the UI shows live progress.
- **Runtime settings** (model, device, compute type, batch, chunk length, VAD, generation mode, language, gap threshold) are stored in `system_settings` and applied via `asr_service.apply_runtime_settings`.

## HLS transcoding

`transcoder/hls.py` shells out to **ffmpeg** to produce HLS v4 playlists (`master.m3u8`) with 10-second AAC MPEG-TS segments (`segment_%05d.ts`):

- Single file: `-map 0:a:0 -vn -sn -dn -c:a aac -b:a 128k`.
- Multi-track: concatenates `audio_files[]` via a `concat.txt` demuxer, then transcodes to a single playlist.
- Segment serving (`get_segment`) is path-traversal guarded; a 7-day `cleanup_segments` keeps the cache bounded.

Playlists are cached per book under `HLS_DIR` (`<covers_dir>/../hls/<book_id>/`) and only transcoded on first play.

## Database migrations

Alembic lives in `app/alembic/` (`alembic.ini` at the package root). The app applies migrations automatically on startup; for host development:

```bash
cd apps/backend
alembic upgrade head                      # apply
alembic revision --autogenerate -m "msg"  # create a new migration
```

## Testing

FastAPI tests run against **SQLite** (`sqlite+aiosqlite:///./test.db`) and **fakeredis** — no external services needed:

```bash
cd apps/backend
pip install -e ".[dev]"
pytest
```

The suite (`app/tests/`) covers: ASR service internals (`test_asr_service.py`), auth + JWT/session flows (`test_auth.py`, `test_auth_token.py`, `test_session_service.py`), book access scoping (`test_books_access.py`), chapter detection (`test_chapter_service.py`), subtitle generation (`test_generate_subtitles.py`, `test_subtitles.py`), HLS transcoding (`test_hls_transcoder.py`), the library scanner (`test_libraries.py`), and metadata providers (`test_metadata.py`). `conftest.py` provides the app/client fixture with a pre-set JWT.

For end-to-end coverage see `tests/e2e/` at the repo root and `../README.md#testing`.
