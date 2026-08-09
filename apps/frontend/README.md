# Todds Library Frontend

> Next.js 14 (App Router) UI for the Todds Library ebook & audiobook server.

Dark-mode-first, shadcn/ui-style interface with an in-browser EPUB reader, an HLS audiobook player with word-level karaoke captions, full-text search, an admin panel, and first-run setup.

- **Stack:** Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS v3, Radix UI primitives, TanStack React Query v5, Zustand, NextAuth v4
- **API access:** via a same-origin rewrite `/backend-api/*` → `http://backend:8000/api/*` (Next.js `afterFiles` rewrite in `next.config.js`)

## Table of contents

- [Routes](#routes)
- [Getting started](#getting-started)
- [Environment variables](#environment-variables)
- [Authentication](#authentication)
- [API client](#api-client)
- [State management & data fetching](#state-management--data-fetching)
- [Component map](#component-map)
- [Readers & player](#readers--player)
- [Styling](#styling)
- [Docker](#docker)
- [Testing](#testing)

## Routes

| Route | File | Purpose |
|---|---|---|
| `/` | `src/app/page.tsx` | Auth/setup redirect: → `/dashboard`, `/register`, or `/login` |
| `/login` | `src/app/login/page.tsx` | Username/password + optional Authentik SSO |
| `/register` | `src/app/register/page.tsx` | First-run admin creation (only when `needs_setup`) |
| `/dashboard` | `src/app/(authenticated)/dashboard/page.tsx` | Continue Reading + Recently Added |
| `/books` | `src/app/(authenticated)/books/page.tsx` | Browse all books: search, format filter, sort, grid/list, paginated |
| `/books/[id]` | `src/app/(authenticated)/books/[id]/page.tsx` | Book detail: cover, actions, metadata, description, bookmarks |
| `/books/[id]/read` | `.../books/[id]/read/page.tsx` | EPUB reader or PDF viewer (redirects to `/listen` for audio-only) |
| `/books/[id]/listen` | `.../books/[id]/listen/page.tsx` | Audiobook player (redirects to `/read` for ebook-only) |
| `/libraries` | `src/app/(authenticated)/libraries/page.tsx` | List libraries; admin can add/scan/delete |
| `/libraries/[id]` | `.../libraries/[id]/page.tsx` | Per-library book browsing |
| `/search` | `src/app/(authenticated)/search/page.tsx` | Full-text search (`?q=`), filter chips |
| `/settings` | `src/app/(authenticated)/settings/page.tsx` | Profile, admin shortcuts, reading preferences (non-functional) |
| `/admin` | `src/app/admin/page.tsx` | Admin dashboard: stat cards + libraries overview |
| `/admin/metadata` | `src/app/admin/metadata/page.tsx` | Metadata editor with provider lookup + apply workflow |
| `/admin/settings` | `src/app/admin/settings/page.tsx` | ASR/Whisper system settings + generation logs |
| `/admin/users` | `src/app/admin/users/page.tsx` | User management (create/edit/delete) |

Layouts: the `(authenticated)` group requires a session; the `admin` group additionally requires `isAdmin` (otherwise redirected). `src/middleware.ts` uses NextAuth `withAuth` to protect `/dashboard`, `/books`, `/libraries`, `/search`, `/settings`, `/admin`.

## Getting started

```bash
# from the repo root
pnpm install
pnpm --filter frontend dev
# → http://localhost:3000 (backend on :8830, see root README)
```

## Environment variables

See `apps/frontend/.env.example`:

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Browser-facing API base | `http://localhost:8830/api` (dev) / `/backend-api` (Docker) |
| `NEXTAUTH_URL` | Public URL of this app | `http://localhost:3000` |
| `NEXTAUTH_SECRET` | NextAuth signing secret | — |
| `AUTHENTIK_ISSUER` / `AUTHENTIK_CLIENT_ID` / `AUTHENTIK_CLIENT_SECRET` | OIDC provider (blank = local auth only) | blank |
| `API_INTERNAL_URL` | Server-side backend URL used by NextAuth | `http://backend:8000/api` |

> Note: `NEXT_PUBLIC_API_URL` is baked in at **build time** when using Docker — pass it as a build arg (`NEXT_PUBLIC_API_URL`). A loopback heuristic swaps `localhost` URLs for the same-origin `/backend-api` proxy when the ports differ, so dev-mode proxies through Next.js.

## Authentication

All in `src/lib/auth.ts` (`authOptions`) and exposed at `/api/auth/[...nextauth]`:

- **JWT session strategy** (30-day max age, custom cookie name, `httpOnly`, secure when HTTPS).
- **Credentials provider** — proxies to backend `POST /auth/login`, stores backend `access_token` + `session_token` on the NextAuth token.
- **Authentik OIDC provider** — only registered when all three `AUTHENTIK_*` env vars are set; on `signIn` it exchanges the Authentik `id_token` with backend `POST /auth/authentik`.
- **Proactive token refresh** — the `jwt` callback decodes the backend access token's `exp` and, within 10 minutes of expiry, calls `POST /auth/refresh` with the session token (Redis-backed, 30-day sliding TTL) to swap in fresh tokens.
- **`useAuth` hook** (`src/hooks/use-auth.ts`) wraps `useSession` and provides `login`, `loginLocal`, `logout`, `isAuthenticated`, `user`.

The session token pair is bridged into the API client by `SessionTokenBridge` in `src/app/providers.tsx`.

## API client

`src/lib/api-client.ts` is a small typed fetch wrapper:

- Resolves the base URL (`NEXT_PUBLIC_API_URL` or `/backend-api`), with the loopback-port heuristic described above.
- Attaches `Authorization: Bearer <accessToken>` and waits up to 5s for the session token to be known on first load.
- **401 handling** — refreshes the session once (deduplicated in-flight) and retries; if refresh fails, invokes the unauthorized handler (`signOut` → `/login`).
- Throws structured `ApiError { status, message, details }`; handles `FormData` (no `Content-Type`) and 204 responses.
- Exposes `api.get/post/put/patch/delete`, `getApiUrl(path)`, and `getAuthHeaders()` (used for `<img>`/`<audio>` URLs with `?access_token=`).

## State management & data fetching

- **Server state** — TanStack React Query v5 (`staleTime: 60s`, `retry: 1`, no refetch on window focus), configured in `src/app/providers.tsx`.
- **Client/UI state** — Zustand for the player (`src/stores/player-store.ts`), local `useState` elsewhere.
- **Hooks** — one hook per domain under `src/hooks/`: `use-books.ts` (queries + progress/bookmark mutations, cache invalidation), `use-libraries.ts` (CRUD + scan + dir browser), `use-search.ts` (debounced query), `use-settings.ts` (ASR settings + 3s-polled generation logs), `use-admin-users.ts`, `use-auth.ts`.

## Component map

```
src/components/
├── books/            book-card.tsx · book-grid.tsx · book-detail.tsx (legacy)
├── layout/           shell.tsx · sidebar.tsx · header.tsx
├── libraries/        add-library-dialog.tsx (filesystem browser)
├── player/           audiobook-player.tsx · chapter-list.tsx · sleep-timer.tsx
│                     player-controls.tsx (legacy)
├── reader/           epub-reader.tsx · pdf-reader.tsx · subtitle-overlay.tsx
├── search/           search-bar.tsx (legacy, not wired)
└── ui/               14 shadcn-style primitives (Radix): button, dialog, select,
                      slider, tabs, toast, tooltip, avatar, badge, dropdown-menu,
                      input, popover, scroll-area, skeleton, card
```

## Readers & player

### EPUB reader (`components/reader/epub-reader.tsx`)
- epub.js-based paginated viewer (dynamically imported).
- TOC sidebar, in-book search, bookmarks, 4 themes (light/dark/sepia/OLED), font-size controls, fullscreen, swipe + click zones + arrow keys.
- Progress synced to the backend on `relocated` events (CFI locations → `POST /books/:id/progress`).

### PDF viewer (`components/reader/pdf-reader.tsx`)
- Fetches the PDF as a blob and renders it in an `<iframe>` with a download button.

### Audiobook player (`components/player/audiobook-player.tsx`)
- `react-h5-audio-player` base, heavily restyled (mobile breakpoint reorders controls).
- **Streaming:** tries `hls.js` against `book.stream_url`, falls back to native audio on the download URL, and uses per-track URLs for multi-track books (with offsets from chapter positions).
- **Chapters:** built from `book.chapters` with missing `end` filled from the next start or total duration; auto-detects the current chapter; click-to-seek sidebar.
- **Captions:** loads SRT/VTT/word-timed JSON per chapter; three modes — inline panel, player overlay, and a fullscreen "page-flip" karaoke view with word highlighting (`subtitle-overlay.tsx`).
- **Controls:** sleep timer (incl. "end of chapter"), speed 0.5–3×, volume slider, ±10s skip, fullscreen with auto-hiding controls.
- **Generation:** "Generate Subtitles" / "Generate Chapters" buttons (admin-only "Force Regenerate"), toast feedback, progress saved every 30s + on pause/end.

## Styling

- **Tailwind v3** with a CSS-variable theme in `src/app/globals.css`: dark by default (`:root` = slate-blue background, gold `primary`), `.light` overrides defined.
- **shadcn/ui-style** components via `cn()` (`clsx` + `tailwind-merge`); custom `sidebar` palette and scrollbar utilities.
- `@layer components` restyles the audio player (`.rhap_*`) to match the theme, including a mobile-first control layout.

## Docker

See `apps/frontend/Dockerfile`:

- Multi-stage: `deps` (pnpm frozen install of workspace deps) → `builder` (`NEXT_PUBLIC_API_URL` build arg, telemetry off, `pnpm run build --filter=frontend`) → `runner` (non-root `nextjs` user, **standalone** output, `node apps/frontend/server.js` on port 3000).
- `next.config.js`: `output: 'standalone'`, `outputFileTracingRoot: '../../'` (monorepo), `transpilePackages: ['@todds-library/shared-types']`, the `/backend-api` rewrite, and `images.remotePatterns` derived from `NEXT_PUBLIC_API_URL`.
- The compose service maps `${FRONTEND_PORT:-3330}:3000` and sets `API_INTERNAL_URL=http://backend:8000/api`.

## Testing

- **Playwright e2e** lives at the repo root (`tests/e2e/`, config `playwright.config.ts`) and targets `http://localhost:3330` by default.
- Several specs **mock the backend** via `page.route('**/backend-api/**')` and seed a real NextAuth JWT cookie; live specs run against the Dockerized stack (`E2E_AUTH_FIXTURE` mints a token inside the backend container).
- Run: `pnpm test:e2e` (see the [root README's Testing section](../README.md#testing)).

## Known limitations

- **Reading Preferences** on `/settings` are non-functional (decorative Save button).
- **Legacy/unwired components:** `components/search/search-bar.tsx` (Cmd+K search), `components/player/player-controls.tsx`, `components/books/book-detail.tsx` (superseded by the book detail page), and `src/app/login/page.tsx.backup`.
- The PDF reader does not sync reading progress.
- All pages are client components — no server components / SSR data fetching is used.
