import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createRequire } from 'node:module';

const frontendRequire = createRequire(`${process.cwd()}/apps/frontend/package.json`);
const { encode } = frontendRequire('next-auth/jwt') as {
  encode: (params: { secret: string; token: Record<string, unknown>; maxAge: number }) => Promise<string>;
};

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://localhost:3330';
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'change_me_in_production';

const book = {
  id: '00000000-0000-4000-8000-000000000301',
  title: 'Lock Resume Audiobook',
  author: 'Example Author',
  format: 'mp3',
  file_format: 'mp3',
  file_size: 1024,
  file_path: '/books/mock-audiobook.mp3',
  cover: null,
  cover_url: null,
  download_url: '/backend-api/books/00000000-0000-4000-8000-000000000301/download',
  audio_download_url: '/backend-api/audiobooks/00000000-0000-4000-8000-000000000301/download',
  stream_url: '/backend-api/audiobooks/00000000-0000-4000-8000-000000000301/stream',
  has_ebook: false,
  has_audiobook: true,
  ebook_format: null,
  audiobook_format: 'mp3',
  audio_track_count: 2,
  duration: 120,
  page_count: null,
  publisher: null,
  isbn: null,
  series: null,
  description: 'Mock audiobook for lock/resume reconnect checks.',
  created_at: '2026-07-25T00:00:00Z',
  updated_at: '2026-07-25T00:00:00Z',
  chapters: [
    { id: 'chapter-1', title: 'Chapter 1', index: 1, start_position: 0 },
    { id: 'chapter-2', title: 'Chapter 2', index: 2, start_position: 60 },
  ],
};

test('reconnects the stream when playback silently stalls after the phone locks', async ({ browser }) => {
  const requests: Array<Req> = [];
  const { page } = await setupContext(browser, requests);
  await mockBackend(page, requests);

  await page.goto(`/books/${book.id}/listen`);
  await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();
  await expect(page.locator('audio')).toHaveAttribute('src', /\/audiobooks\/.*\/download/);

  const countDownloadRequests = () =>
    requests.filter((r) => r.method === 'GET' && r.path === `/audiobooks/${book.id}/download`).length;

  const initialDownloads = countDownloadRequests();

  // Simulate active playback on a multi-track (direct) stream.
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('audio element missing');
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 30 });
    audio.play = () => Promise.resolve();
    audio.dispatchEvent(new Event('play'));
  });
  await page.waitForTimeout(400);

  // Lock the phone: page suspends, connection dies.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // Unlock: element still reports "playing" but its clock is frozen.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // The resume monitor should detect the silent stall and reload the stream
  // with a fresh token instead of requiring a manual reload.
  await expect.poll(countDownloadRequests).toBeGreaterThan(initialDownloads);

  const fresh = requests
    .filter((r) => r.method === 'GET' && r.path === `/audiobooks/${book.id}/download`)
    .pop();
  expect(fresh).toBeDefined();
  expect(fresh!.search).toContain('access_token=');
});

test('saves the exact position when paused via background (notification) controls', async ({ browser }) => {
  const requests: Array<Req> = [];
  const { page } = await setupContext(browser, requests);
  await mockBackend(page, requests);

  await page.goto(`/books/${book.id}/listen`);
  await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();

  // Simulate playing with a mutable element clock.
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('audio element missing');
    (window as unknown as { __clock: number }).__clock = 10;
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(audio, 'currentTime', {
      configurable: true,
      get: () => (window as unknown as { __clock: number }).__clock,
    });
    audio.play = () => Promise.resolve();
    audio.dispatchEvent(new Event('play'));
  });
  await page.waitForTimeout(400);

  // Background the tab: the hidden flush saves the position at this moment.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // Playback continues in the background; the clock advances to 30.
  await page.evaluate(() => {
    (window as unknown as { __clock: number }).__clock = 30;
  });

  // User taps pause on the Android notification / lock-screen controls. This
  // produces the element's native 'pause' event (the same event every pause
  // source funnels through), which must flush the exact position.
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('audio element missing');
    audio.dispatchEvent(new Event('pause'));
  });

  const lastProgressPosition = () => {
    const posts = requests.filter((r) => r.method === 'POST' && r.path === `/books/${book.id}/progress`);
    return posts.length > 0 ? posts[posts.length - 1].position : undefined;
  };

  // The pause-time position (30) must be the last one flushed — not the stale
  // hidden-time position (10).
  await expect.poll(lastProgressPosition).toBe(30);
});

test('restores saved position for single-file audiobooks', async ({ browser }) => {
  const requests: Array<Req> = [];
  const singleFileBook = { ...book, audio_track_count: 1, chapters: [] };
  const { page } = await setupContext(browser, requests);
  await mockBackend(page, requests, { bookOverride: singleFileBook, progressPosition: 42 });

  await page.goto(`/books/${book.id}/listen`);
  await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();

  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('audio element missing');
    Object.defineProperty(audio, 'readyState', {
      configurable: true,
      get: () => HTMLMediaElement.HAVE_METADATA,
    });
    audio.dispatchEvent(new Event('loadedmetadata'));
  });

  await expect.poll(async () =>
    page.evaluate(() => document.querySelector('audio')?.currentTime)
  ).toBe(42);
});

interface Req {
  path: string;
  method: string;
  search: string;
  position?: number;
}

async function setupContext(
  browser: import('@playwright/test').Browser,
  requests: Req[]
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext();
  await seedSession(context);
  const page = await context.newPage();
  return { page, context };
}

async function seedSession(context: BrowserContext) {
  const sessionToken = await encode({
    secret: NEXTAUTH_SECRET,
    token: {
      sub: '00000000-0000-4000-8000-000000000001',
      id: '00000000-0000-4000-8000-000000000001',
      name: 'mock-user',
      email: 'mock@example.local',
      isAdmin: false,
      accessToken: 'mock-access-token',
    },
    maxAge: 24 * 60 * 60,
  });

  await context.addCookies([
    {
      name: 'next-auth.session-token',
      value: sessionToken,
      url: FRONTEND_URL,
      httpOnly: true,
      sameSite: 'Lax',
      secure: false,
    },
  ]);
}

async function mockBackend(
  page: Page,
  requests: Req[],
  options: { bookOverride?: typeof book; progressPosition?: number } = {}
) {
  const servedBook = options.bookOverride ?? book;
  const progressPosition = options.progressPosition ?? 0;

  await page.route('**/backend-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/backend-api', '');
    const method = route.request().method();
    requests.push({ path, method, search: url.search });

    if (path === `/books/${book.id}`) {
      return json(route, servedBook);
    }
    if (path === `/books/${book.id}/progress`) {
      if (method === 'POST') {
        const body = route.request().postDataJSON() as { position?: number } | null;
        requests[requests.length - 1].position = body?.position;
      }
      return json(route, {
        progress: servedBook.duration ? progressPosition / servedBook.duration : 0,
        position: progressPosition,
        location: null,
      });
    }
    if (path === `/books/${book.id}/chapters/chapter-1/subtitles` && url.searchParams.get('format') === 'json') {
      return json(route, {
        language: 'en',
        text: 'Generated subtitle text',
        cues: [
          {
            start: 0,
            end: 30,
            text: 'Generated subtitle text',
            words: [{ start: 0, end: 10, text: 'Generated' }],
          },
        ],
      });
    }
    if (path === `/books/${book.id}/chapters/chapter-1/subtitles`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/x-subrip',
        body: '1\n00:00:00,000 --> 00:00:30,000\nGenerated subtitle text\n',
      });
    }
    if (path === `/audiobooks/${book.id}/download`) {
      return route.fulfill({
        status: 200,
        contentType: 'audio/mpeg',
        // Browsers cache media responses; force a network round-trip so a
        // re-set of the (identical) src is observable as a fresh request.
        headers: { 'cache-control': 'no-store' },
        body: Buffer.from('mock audio'),
      });
    }

    return json(route, {});
  });

  await page.route('**/api/auth/session', async (route) => json(route, {
    user: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'mock-user',
      email: 'mock@example.local',
      isAdmin: false,
    },
    accessToken: 'mock-access-token',
    expires: '2099-01-01T00:00:00.000Z',
  }));
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
}
