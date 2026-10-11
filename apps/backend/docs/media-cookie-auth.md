# Media Auth via Session Cookie (Pinned Design)

**Status:** design pinned, not implemented.
**Goal:** retire `?access_token=` from media URLs (covers, downloads, streams, HLS
segments) without breaking background PWA playback on mobile.

## Decision

Use the existing **opaque Redis `session_token`** as an
`HttpOnly; Secure; SameSite=Lax` cookie (`tl_session`) for media auth.
Keep the 15-min HS256 access JWT as the `Authorization` header credential
for JSON API calls. Keep the existing 2-min keepalive — it becomes the
cookie janitor for backgrounded tabs.

## Why the session token (not the access JWT)

1. It is already the session-keepalive credential: `POST /auth/refresh
   {session_token}`, and `get_session()` (`app/services/session_service.py`)
   already slides the Redis TTL on every read.
2. It is revocable; the JWT is not. Logout, admin user-delete, and
   `revoke_all_user_sessions()` all operate on the Redis session ID.
   A revoked cookie fails closed (401) on the next media request.
3. It carries no claims. The backend resolves it to the live user row per
   request, so admin demotions and deletions take effect immediately —
   same semantics as today's header flow.

## Backend changes

1. **Set the cookie** on `POST /auth/login`, `POST /auth/register`,
   `POST /auth/authentik`, and `POST /auth/refresh`
   (`app/api/auth.py`, via `_auth_response()`):
   `Set-Cookie: tl_session=<token>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=<session TTL>`.
   Keep returning the JSON `{access_token, session_token}` during migration.
2. **Read the cookie** in `get_current_user_from_request()`
   (`app/dependencies.py:54-63`) as a third source, after
   `Authorization` header and before the legacy `?access_token=` fallback:
   `request.cookies.get("tl_session")` → `get_session()` (Redis).
3. **Clear the cookie** on `POST /auth/logout` and admin user-delete:
   `Set-Cookie: tl_session=; Max-Age=0`.
4. **CORS** already has `allow_credentials=True` (`app/main.py:52`).
   Direct-`NEXT_PUBLIC_API_URL` callers need `credentials: "include"`
   (fetch) / `xhr.withCredentials = true` (hls.js `xhrSetup`).
   Same-origin `/backend-api` (rewritten to `backend:8000` in
   `apps/frontend/next.config.js`) sends the cookie automatically.

## Frontend changes (mostly deletion)

- Delete URL-stamping helpers: `withAccessToken` (`hooks/use-books.ts:75-80`,
  `hooks/use-search.ts:19-25`), `withFreshToken`
  (`components/player/player-host.tsx:135-141`).
- Stop baking `?access_token=` into `cover` / `download_url` /
  `audio_download_url` / `stream_url` (`use-books.ts:86-98`,
  `use-search.ts:27-43`).
- HLS `xhrSetup` no longer re-stamps per segment; rely on the cookie
  (add `withCredentials` only for the cross-origin fallback path).
- Convert raw media `fetch()` calls (epub/pdf readers, subtitle overlay,
  downloads) to a single `fetchMedia()` helper: live `Authorization`
  header where possible, cookie otherwise, 401 → existing
  `refreshAuthSession()` + single replay.
- Fix the bare `<a href>` Castwright stream link
  (`castwright-chapter-generate.tsx:62-63`) — currently sends no auth at all.
- Strip token-bearing URLs from the persisted player store
  (re-stamp/resolve on load instead).

## Lifecycle

- Login → `create_session()` → `Set-Cookie` (30d).
- Keepalive `POST /auth/refresh` → TTL slides → response re-sets the cookie.
  Backgrounded mobile tabs stay alive with no new client logic.
- Logout / user-delete → revoke + clearing cookie → media 401s.

## CSRF note

Media endpoints are all `GET`s (no CSRF defense needed beyond
no-CORS-wildcard-with-credentials, already true). Mutations stay on JSON
`fetch` with the header token, not the cookie. `SameSite=Lax` covers the
practical surface.

## Open decision: cutover mode

- **Gradual (recommended):** cookie alongside JSON tokens; query param as
  deprecated fallback, then removed. Zero-downtime for PWA-cached stale URLs.
- **Direct:** cookie-only for media endpoints immediately. Cleaner, but
  invalidates anything baked before deploy.

## Explicitly out of scope

- Refresh-loop consolidation (keepalive + reconnect + player polling stay as-is
  to support background PWA work on mobile).
- PWA icon/SW work (deferred).
- Short-lived signed media URLs (optional follow-up; the cookie alone removes
  secrets from logs/history/Referer/persisted caches).
