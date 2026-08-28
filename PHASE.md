# Mobile Background-Process Support — Phase Plans

Goal: make Todds Library behave like a real background app when minimized on a mobile device (iOS Safari + Android Chrome).

Current state: no PWA shell, no Media Session, no global audio host, no background-safety nets. Playback stops on navigation; up to 30s of progress can be lost when the tab is killed; stream URLs bake a short-lived `access_token` that can expire during long backgrounded playback.

---

## Phase 1 — Media Session + progress flush ✅ (implemented)

Lock-screen / notification controls and no-lost-progress-on-kill. Makes background audio reliable (esp. iOS Safari, which needs a playing audio element + media session to keep going when locked).

- **`src/hooks/use-media-session.ts`** (new) — wires `navigator.mediaSession`:
  - `metadata` = title/artist + artwork from `book.cover` (already tokenized URL).
  - `playbackState` synced to the store's `isPlaying`.
  - `setPositionState({duration, playbackRate, position})` throttled on `timeupdate`.
  - Action handlers → the real audio element / store: `play`, `pause`, `previoustrack`, `nexttrack`, `seekto`, `seekbackward`, `seekforward`.
  - Guard every call (capability + `try/catch`) since iOS Safari supports a subset.
- **`src/lib/api-client.ts`** — added `postProgressWithKeepalive(bookId, data)`: a `keepalive: true` POST to `/books/{id}/progress` that survives tab kill/background.
- **`src/components/player/audiobook-player.tsx`**:
  - Calls `useMediaSession(...)` wired to the real audio element and store callbacks.
  - Progress flush on `pagehide` + `visibilitychange → hidden` (bypasses the 30s `onListen` cadence).
  - Fixed latent bug: fullscreen play/pause button only flipped the store flag; now `toggleAudio` drives the element directly.

Verification: `pnpm typecheck` / `lint` / `build` pass; mock-based listen specs pass; scratch browser spec confirmed Media Session metadata registration and pagehide keepalive flush.

---

## Phase 2 — Installable PWA (manifest + service worker)

- **`src/app/manifest.ts`** — name, `display: 'standalone'`, `start_url`, theme/background colors, icons, `id`.
- **Icons** — SVG source in `public/icons/icon.svg` (placeholder; user can replace) + `scripts/generate-icons.mjs` using `sharp` (add as devDep) to emit `icon-192.png`, `icon-512.png`, `maskable-512.png`, `apple-touch-icon.png`. Run in `prebuild`.
- **`src/app/layout.tsx`** — `metadata.manifest`, `metadata.icons`, `metadata.appleWebApp` (iOS standalone), `themeColor`; new `export const viewport` with `viewportFit: 'cover'` for notch devices.
- **Service worker** — wrap `next.config.js` with `@ducanh2912/next-pwa` (App Router + standalone compatible). Precache the build shell, **network-only** for `/backend-api` and audio streams (never cache media). Register only in production via `providers.tsx`.
- Risk to verify: standalone output + next-pwa; if the build breaks, fall back to a hand-rolled `public/sw.js` registered manually (still satisfies Chrome A2HS).

## Phase 3 — Persistent player across navigation (largest, do last)

Playback currently dies on navigation because the `<audio>` element lives only on `/listen` and is destroyed on unmount.

- **Extend `use-player.ts` store** — add `currentBookInfo: {title, author, cover} | null` for the mini-player.
- **New global audio engine** — a `PlayerHost` mounted in `(authenticated)/layout.tsx` (inside `Shell`) owning a persistent `<audio>` element + all HLS/track/retry logic (moved from `audiobook-player.tsx`), exposed via an `AudioPlayerContext` (`{audioRef, play, pause, seek, setTrack, …}`).
- **Refactor `audiobook-player.tsx` into a pure view** — keeps chapters, subtitles, sleep timer, fullscreen karaoke; drives the engine instead of `playerRef.current.audio.current`.
- **New `MiniPlayer`** in `shell.tsx` — cover, title, play/pause, progress, link back to `/listen`, shown whenever `currentBook` is set.
- Tradeoff: raw `<audio>` + custom transport controls (matches app styling, bigger UI work) vs. keeping `react-h5-audio-player` as the global host (less UI work, but its controls render at the layout). Recommended: engine + custom controls.

## Phase 4 — Wake lock for immersive captions

- **New `src/hooks/use-wake-lock.ts`** — `navigator.wakeLock.request('screen')` while the fullscreen karaoke/subtitle mode is active; re-acquire on `visibilitychange → visible` (wake locks auto-release when hidden); no-op where unsupported.

## Phase 5 — Auth/token for long background sessions ✅ (implemented)

Two gaps: stream URLs bake a short-lived `access_token`, and the auth keepalive stops refreshing while hidden.

- **hls.js `xhrSetup`** — inject the *current* token into every manifest/segment request instead of baking it at `loadSource`, so segments never go stale mid-book (`audiobook-player.tsx`). Backend re-bakes the manifest's token into every segment URL on each playlist fetch (`api/audiobooks.py`), so fresh manifest requests propagate fresh tokens to segments.
- **Refresh while hidden when playing** — the player drives `refreshAuthSession()` on a 60s interval while `isPlaying` (visible or not), independent of the global keepalive.
- `.env.example` — added guidance that `ACCESS_TOKEN_TTL` should stay ≥ expected backgrounded-playback duration.

Verification: browser spec confirmed (a) HLS manifest + segment requests carry `access_token` via `xhrSetup`, and (b) a 60s refresh fires during playback (fake clock) with no visibility check. Regression: mock-based listen specs still pass.

## Phase 6 — Connection resilience for mobile background/resume ✅ (implemented)

Symptom: after minimizing the app, returning showed it "fully disconnected" until a manual reload. Root cause: a backgrounded mobile tab's network connections die (carrier NAT / OS suspension) and the app had no timeouts, no retry, no refetch-on-resume, and no player reconnect — so wedged requests hung the UI.

- **`src/lib/api-client.ts`** — every request now gets a 20s `AbortController` timeout (`fetchWithTimeout`), and transient network failures/timeouts retry up to 2× with backoff on fresh connections. `performRefresh` gets a 15s timeout. The `keepalive` progress flush is untouched.
- **`src/app/providers.tsx`** — `refetchOnWindowFocus: true` (react-query + SessionProvider) so returning to the app re-fetches stale queries with fresh tokens/connections.
- **`src/hooks/use-reconnect.ts`** (new) — on `visibilitychange → visible`, `pageshow`, and `focus`: `refreshAuthSession()` + `queryClient.invalidateQueries()` to rehydrate the app.
- **`src/components/player/audiobook-player.tsx`**:
  - Reconnect-on-resume with position restore: on visible, if `isPlaying` and the stream is stalled (paused/ended or time didn't advance since hidden), refresh the token and reload the stream (hls.js / iOS-native / direct), seeking back to the saved position.
  - `fallbackToDirect()` preserves the position when the HLS retry exhausts (was restarting at 0).
  - `reloadAudioSrc()` forces a reload even when the tokenized URL string is unchanged.
- **`apps/backend/app/services/audiobook_service.py`** — ffmpeg HLS transcode now runs via `asyncio.to_thread` (was a blocking `subprocess.run(..., timeout=3600)` that froze a worker's event loop) + a per-book `asyncio.Lock` so concurrent stream requests to the same book don't collide writing segments.
- **`apps/backend/entrypoint.py`** — uvicorn `timeout_keep_alive` raised from the 5s default to 30s (`UVICORN_TIMEOUT_KEEP_ALIVE`).

Verification: `pnpm typecheck` / `lint` / `build` pass; backend `pytest` passes (121 passed, 4 pre-existing failures unrelated to this change — confirmed identical on `main`); new mock spec `tests/e2e/connection-resilience.spec.ts` covers dropped-request retry and resume refetch; subtitle-regression specs still pass.

Not covered by automation (needs a real device): iOS native-HLS resume seek, direct-track position restore on live errors, and the 5–10 min minimize→resume manual check.

---

## Phase 6.1 — Android lock: detect silent stall + never lose track position ✅ (implemented)

Symptom: on Android, locking the phone (while listening) drops the connection **and** resets the current track to its start on unlock. Root cause: Phase 6's reconnect skipped when the position had advanced while hidden (`timeOnHiddenRef` early-exit) — that matched minimize but not lock (audio keeps "playing" through a lock while the connection dies mid-lock). And the multi-track direct path fell through `onError → setupHlsStream → setupDirectAudio` which reloaded track 0 from the beginning.

- **`src/components/player/audiobook-player.tsx`**:
  - Removed `timeOnHiddenRef`/`lastAudioAdvanceRef`; the flush effect now snapshots `wasPlayingBeforeHiddenRef = isPlayingRef.current` on hidden/pagehide.
  - Resume monitor (`visibilitychange → visible` / `pageshow`): if it was playing and the element is now paused/ended → reconnect immediately; otherwise sample `currentTime` and, after 3s, reconnect if the clock is still frozen while `isPlaying` (silent stall). No longer skipped because the position advanced during the lock.
  - New `capturePositionForReload()` records the current position before any reload (falls back to the store-synced time when the element clock is unusable; multi-track local = `currentTime - trackStart(trackIndex)`). Used by `onError`, `fallbackToDirect`, `retryStream`, and `reconnectStream`.
  - `reconnectStream` rewritten: no stall-detection side effects; calls `capturePositionForReload()` then reloads via the right path (multi-track direct / refresh+token / hls.js / native HLS / direct), preserving the position.
  - `reloadAudioSrc` now calls `audio.load()` explicitly and resumes playback if the app thinks it's playing — browsers otherwise treat an identical src re-set as a no-op, so the reconnect never actually re-fetched the dead stream (this was the final bug).
  - hls.js config hardened: `manifest/levelLoadingTimeOut: 8000`, `fragLoadingTimeOut: 10000`, max retries 2 — so a dead connection errors fast and routes to the token-refresh reload instead of silently retrying for minutes.
  - `retryStream` and `onError` call `capturePositionForReload()` before their reload/fallback paths.
  - **Pause flush:** progress is now flushed (via `postProgressWithKeepalive`) the moment the element pauses — every pause source (app controls, custom controls, Media Session / Android notification / lock-screen controls) funnels through the native `pause` event → `onPause`, so a background pause persists the exact position instead of leaving it up to 30s stale (the last `onListen`) or relying on a hidden/pagehide flush that already ran at an older position.

Verification: `pnpm typecheck` / `lint` / `build` pass; new mock spec `tests/e2e/lock-resume.spec.ts` simulates lock (hidden) → unlock (visible) with a frozen element clock and asserts the stream re-fetches (a fresh `/audiobooks/{id}/download` request with a token) via the resume monitor; it also simulates a background pause (native `pause` event) and asserts the exact pause position (not the stale hidden-time position) is POSTed to `/books/{id}/progress`; `connection-resilience` and `subtitle-generation-ui` specs still pass (the latter's toast assertion was made strict-mode-safe with `exact: true` — it flaked on sonner's `aria-live` mirror text). Full-suite run shows only the documented pre-existing backend/admin/environmental failures.

Not covered by automation (needs a real device): Android lock→unlock with live HLS/direct streams (verify audible resume + position), and the same flow on iOS.

---

## Suggested order & verification

Order: Phase 1 ✅ → 2 → 4 → 5 ✅ → 3 (3 last, it touches the most code).

After each phase: `pnpm typecheck`, `pnpm lint`, `pnpm build`; run the mock-based Playwright listen specs (`tests/e2e/subtitle-generation-ui.spec.ts`); manual checks: lock-screen controls on iOS/Android, Add-to-Home-Screen install, background playback 30+ min, navigate away mid-play (Phase 3), kill tab → progress restored.

---

## Environment notes (from Phase 1 work)

- Running e2e mock specs needs a frontend server whose `NEXTAUTH_SECRET` matches the test's `NEXTAUTH_SECRET` (middleware validates the seeded session cookie).
- `NEXT_PUBLIC_API_URL` is absolute (`http://localhost:8830/api`); run the dev server on a port ≠ 8830 so the client rewrites to same-origin `/backend-api`, which the mocks intercept.
- Headless Chromium on this host needs `LD_LIBRARY_PATH=/home/himynameistodd/.local/lib` (provides `libasound.so.2`).
- Playwright `test-results/` is root-owned (container-created); use `--output=/tmp/...` to redirect artifacts.