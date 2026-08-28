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
  description: 'Mock audiobook for background-sync progress queuing checks.',
  created_at: '2026-07-25T00:00:00Z',
  updated_at: '2026-07-25T00:00:00Z',
  chapters: [
    { id: 'chapter-1', title: 'Chapter 1', index: 1, start_position: 0 },
    { id: 'chapter-2', title: 'Chapter 2', index: 2, start_position: 60 },
  ],
};

// When the direct save is impossible (the backgrounded/locked tab cannot reach
// the network), the page must still persist the exact position into the
// service worker's queue and register Background Sync, so the browser can
// deliver it once connectivity returns.
test('queues the latest position for background sync when direct saves fail while hidden', async ({ browser }) => {
  const requests: Array<Req> = [];
  const { page } = await setupContext(browser, requests);
  await mockBackend(page, requests);

  await page.goto(`/books/${book.id}/listen`);
  await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();

  // Wait until the service worker is registered, active, and controlling the
  // page (needed for Background Sync registration to succeed).
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise<void>((resolve) => {
        navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true });
      });
    }
    void registration;
  });

  // The queue starts empty.
  expect(await page.evaluate(readQueue)).toEqual([]);

  // Simulate active playback with a mutable element clock.
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

  // Background the tab: the hidden flush queues the position at this moment.
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

  // Pause via the Android notification controls. The page's direct save
  // fails (network is down), so this position must only survive via the
  // Background Sync queue.
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('audio element missing');
    audio.dispatchEvent(new Event('pause'));
  });

  // No page-originated save succeeded.
  const pageDelivered = () =>
    requests.filter(
      (r) => r.method === 'POST' && r.path === `/books/${book.id}/progress` && !r.fromSW && r.status === 200
    );
  await page.waitForTimeout(600);
  expect(pageDelivered()).toHaveLength(0);

  // The queue holds exactly one entry — the latest position (the hidden-time
  // entry was coalesced away by the pause-time entry).
  await expect.poll(async () => (await page.evaluate(readQueue)).length).toBe(1);
  const queued = await page.evaluate(readQueue);
  expect(queued[0].bookId).toBe(book.id);
  expect(queued[0].position).toBe(30);

  // Background Sync is registered so the browser will deliver the queued save
  // once connectivity returns, even if this tab is killed in the meantime.
  // Some browsers (e.g. headless Chromium) ship the API but disable it at
  // runtime; the app falls back to a keepalive save in that case, so the
  // registration check is best-effort.
  const tagsResult = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.ready;
    const sync = (
      registration as unknown as { sync: { getTags(): Promise<string[]> } }
    ).sync;
    try {
      return { ok: true as const, tags: await sync.getTags() };
    } catch (error) {
      return { ok: false as const, error: String(error) };
    }
  });
  if (tagsResult.ok) {
    expect(tagsResult.tags).toContain('save-progress');
  } else {
    test.info().annotations.push({
      type: 'note',
      description: `Background Sync unavailable in this browser: ${tagsResult.error}`,
    });
  }
});

interface Req {
  path: string;
  method: string;
  search: string;
  status: number;
  fromSW: boolean;
  position?: number;
}

interface QueueEntry {
  bookId: string;
  position: number;
}

async function setupContext(
  browser: import('@playwright/test').Browser,
  requests: Req[]
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
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

async function mockBackend(page: Page, requests: Req[]) {
  await page.route('**/backend-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/backend-api', '');
    const method = route.request().method();
    // Requests initiated by the service worker have no owning frame.
    const fromSW = route.request().frame() === null;
    requests.push({ path, method, search: url.search, status: 200, fromSW });

    if (path === `/books/${book.id}`) {
      return json(route, book);
    }
    if (path === `/books/${book.id}/progress`) {
      if (method === 'POST') {
        const body = route.request().postDataJSON() as { position?: number } | null;
        requests[requests.length - 1].position = body?.position;
        // The page's direct save is "offline" (fails); only Background Sync
        // should be relied on to deliver the queued position.
        if (!fromSW) {
          requests[requests.length - 1].status = 500;
          return route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ detail: 'offline' }),
          });
        }
      }
      return json(route, { progress: 0, position: 0, location: null });
    }
    if (path === `/audiobooks/${book.id}/download`) {
      return route.fulfill({
        status: 200,
        contentType: 'audio/mpeg',
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

async function readQueue(): Promise<QueueEntry[]> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('todds-library', 1);
    req.onupgradeneeded = () => {
      const database = req.result;
      if (!database.objectStoreNames.contains('progress-queue')) {
        database.createObjectStore('progress-queue', { keyPath: 'bookId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  try {
    return await new Promise<QueueEntry[]>((resolve, reject) => {
      const tx = db.transaction('progress-queue', 'readonly');
      const req = tx.objectStore('progress-queue').getAll();
      req.onsuccess = () => resolve(req.result as QueueEntry[]);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
}