import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createRequire } from 'node:module';

const frontendRequire = createRequire(`${process.cwd()}/apps/frontend/package.json`);
const { encode } = frontendRequire('next-auth/jwt') as {
  encode: (params: { secret: string; token: Record<string, unknown>; maxAge: number }) => Promise<string>;
};

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://localhost:3330';
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'change_me_in_production';

const book = {
  id: '00000000-0000-4000-8000-000000000201',
  title: 'Resilience Audiobook',
  author: 'Example Author',
  format: 'mp3',
  file_format: 'mp3',
  file_size: 1024,
  file_path: '/books/mock-audiobook.mp3',
  cover: null,
  cover_url: null,
  download_url: '/backend-api/books/00000000-0000-4000-8000-000000000201/download',
  audio_download_url: '/backend-api/audiobooks/00000000-0000-4000-8000-000000000201/download',
  stream_url: '/backend-api/audiobooks/00000000-0000-4000-8000-000000000201/stream',
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
  description: 'Mock audiobook for connection resilience checks.',
  created_at: '2026-07-25T00:00:00Z',
  updated_at: '2026-07-25T00:00:00Z',
  chapters: [
    { id: 'chapter-1', title: 'Chapter 1', index: 1, start_position: 0 },
    { id: 'chapter-2', title: 'Chapter 2', index: 2, start_position: 60 },
  ],
};

test('recovers from a dropped first book request by retrying on a fresh connection', async ({ browser }) => {
  const requests: Array<{ path: string; method: string }> = [];
  const { page } = await setupContext(browser, requests);
  let bookRequestCount = 0;

  await mockBackend(page, requests, {
    onBookRequest: (route, method, path) => {
      bookRequestCount += 1;
      if (method === 'GET' && path === `/books/${book.id}` && bookRequestCount === 1) {
        // Simulate a dead/wedged connection from a backgrounded mobile tab.
        return route.abort('failed');
      }
      return null;
    },
  });

  await page.goto(`/books/${book.id}/listen`);
  await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();

  // The first request died, so the client must have retried on a new request.
  expect(bookRequestCount).toBeGreaterThanOrEqual(2);
});

test('re-fetches data when the tab becomes visible again after backgrounding', async ({ browser }) => {
  const requests: Array<{ path: string; method: string }> = [];
  const { page } = await setupContext(browser, requests);
  await mockBackend(page, requests);

  await page.goto(`/books/${book.id}/listen`);
  await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();

  const countBookRequests = () =>
    requests.filter((r) => r.method === 'GET' && r.path === `/books/${book.id}`).length;

  const initial = countBookRequests();
  expect(initial).toBeGreaterThanOrEqual(1);

  // Simulate the user returning to the app after the OS suspended it.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // Reconnect-on-resume should refetch active queries with fresh connections.
  await expect.poll(countBookRequests).toBeGreaterThan(initial);
});

async function setupContext(
  browser: import('@playwright/test').Browser,
  requests: Array<{ path: string; method: string }>
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
  requests: Array<{ path: string; method: string }>,
  options: {
    onBookRequest?: (
      route: Route,
      method: string,
      path: string
    ) => Promise<unknown> | unknown | null;
  } = {}
) {
  const { onBookRequest } = options;

  await page.route('**/backend-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/backend-api', '');
    const method = route.request().method();
    requests.push({ path, method });

    if (path === `/books/${book.id}`) {
      if (onBookRequest) {
        const result = onBookRequest(route, method, path);
        if (result !== null && result !== undefined) {
          await result;
          return;
        }
      }
      return json(route, book);
    }
    if (path === `/books/${book.id}/progress`) {
      return json(route, { progress: 0, position: 0, location: null });
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
            words: [
              { start: 0, end: 10, text: 'Generated' },
              { start: 10, end: 20, text: 'subtitle' },
              { start: 20, end: 30, text: 'text' },
            ],
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