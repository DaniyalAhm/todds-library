import { test, expect, type APIRequestContext, type BrowserContext, type Page, type Route } from '@playwright/test';
import { createRequire } from 'node:module';

const frontendRequire = createRequire(`${process.cwd()}/apps/frontend/package.json`);
const { encode } = frontendRequire('next-auth/jwt') as {
  encode: (params: { secret: string; token: Record<string, unknown>; maxAge: number }) => Promise<string>;
};

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://localhost:3330';
const BACKEND_URL = process.env.E2E_API_URL || 'http://localhost:8830/api';
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'change_me_in_production';
const E2E_USERNAME = process.env.E2E_USERNAME || 'e2eadmin';
const E2E_PASSWORD = process.env.E2E_PASSWORD || 'e2e-password';

const book = {
  id: '00000000-0000-4000-8000-000000000201',
  title: 'Regen Audiobook',
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
  audio_track_count: 1,
  duration: 120,
  page_count: null,
  publisher: null,
  isbn: null,
  series: null,
  description: 'Mock audiobook for admin subtitle regeneration checks.',
  created_at: '2026-07-25T00:00:00Z',
  updated_at: '2026-07-25T00:00:00Z',
  chapters: [
    { id: 'chapter-1', title: 'Chapter 1', index: 1, start_position: 0 },
  ],
};

type AuthFixture = {
  accessToken: string;
  userId: string;
  username: string;
  email: string;
  isAdmin: boolean;
};

type RequestRecord = {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
};

test.describe('Admin subtitle regeneration', () => {
  let admin: AuthFixture;

  test.beforeAll(async ({ request }) => {
    admin = await ensureAdminUser(request);
  });

  test('player shows Force Regenerate Subtitles for admins and sends overwrite=true', async ({
    browser,
  }) => {
    const requests: RequestRecord[] = [];
    const context = await browser.newContext();
    await seedSession(context, admin);
    const page = await context.newPage();
    await mockBackend(page, requests);

    await page.goto(`/books/${book.id}/listen`);
    await expect(page.getByText(book.title)).toBeVisible();

    await page.getByRole('button', { name: 'Force Regenerate Subtitles' }).click();

    await expect.poll(() =>
      requests.some(
        (r) =>
          r.method === 'POST' &&
          r.path === `/books/${book.id}/chapters/chapter-1/generate/subtitles` &&
          r.query.get('overwrite') === 'true'
      )
    ).toBe(true);
    await expect(page.getByText('Subtitles regenerated')).toBeVisible();

    await context.close();
  });

  test('book detail shows Regenerate Subtitles for admins and sends overwrite body', async ({
    browser,
  }) => {
    const requests: RequestRecord[] = [];
    const context = await browser.newContext();
    await seedSession(context, admin);
    const page = await context.newPage();
    await mockBackend(page, requests);

    await page.goto(`/books/${book.id}`);
    await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();

    await page.getByRole('button', { name: 'Regenerate Subtitles' }).click();

    await expect.poll(() =>
      requests.some(
        (r) =>
          r.method === 'POST' &&
          r.path === `/books/${book.id}/generate/subtitles` &&
          (r.body as { overwrite?: boolean })?.overwrite === true
      )
    ).toBe(true);
    await expect(page.getByText('Subtitle regeneration started')).toBeVisible();

    await context.close();
  });

  test('non-admins do not see regeneration controls', async ({ browser, request }) => {
    const username = `nonadmin-${Date.now()}`;
    const password = 'nonadmin-password';
    const createRes = await request.post(`${BACKEND_URL}/auth/users`, {
      headers: {
        Authorization: `Bearer ${admin.accessToken}`,
        'Content-Type': 'application/json',
      },
      data: { username, password, email: `${username}@example.com`, is_admin: false },
    });
    expect(createRes.status()).toBe(201);

    const nonAdmin = await login(request, username, password);
    const context = await browser.newContext();
    await seedSession(context, nonAdmin);
    const page = await context.newPage();
    await mockBackend(page, []);

    await page.goto(`/books/${book.id}`);
    await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Regenerate Subtitles' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Force Regenerate Subtitles' })).toHaveCount(0);

    await page.goto(`/books/${book.id}/listen`);
    await expect(page.getByText(book.title)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Force Regenerate Subtitles' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Generate Subtitles' })).toBeVisible();

    await context.close();
  });
});

async function ensureAdminUser(request: APIRequestContext): Promise<AuthFixture> {
  const loginRes = await request.post(`${BACKEND_URL}/auth/login`, {
    data: { username: E2E_USERNAME, password: E2E_PASSWORD },
  });
  if (loginRes.status() === 200) {
    return authFromBody(await loginRes.json());
  }

  const setupRes = await request.get(`${BACKEND_URL}/auth/setup/status`);
  const { needs_setup } = await setupRes.json();
  if (needs_setup) {
    const registerRes = await request.post(`${BACKEND_URL}/auth/register`, {
      data: { username: E2E_USERNAME, password: E2E_PASSWORD },
    });
    expect(registerRes.status()).toBe(200);
    return authFromBody(await registerRes.json());
  }

  throw new Error('E2E admin user does not exist and server setup is already complete.');
}

async function login(request: APIRequestContext, username: string, password: string): Promise<AuthFixture> {
  const res = await request.post(`${BACKEND_URL}/auth/login`, { data: { username, password } });
  expect(res.status()).toBe(200);
  return authFromBody(await res.json());
}

function authFromBody(body: Record<string, unknown>): AuthFixture {
  return {
    accessToken: String(body.access_token),
    userId: String(body.user_id),
    username: String(body.username),
    email: String(body.email ?? ''),
    isAdmin: Boolean(body.is_admin),
  };
}

async function seedSession(context: BrowserContext, auth: AuthFixture) {
  const sessionToken = await encode({
    secret: NEXTAUTH_SECRET,
    token: {
      sub: auth.userId,
      id: auth.userId,
      name: auth.username,
      email: auth.email,
      isAdmin: auth.isAdmin,
      accessToken: auth.accessToken,
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

async function mockBackend(page: Page, requests: RequestRecord[]) {
  await page.route('**/backend-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/backend-api', '');
    const method = route.request().method();
    let body: unknown;
    const postData = route.request().postData();
    if (postData) {
      try {
        body = route.request().postDataJSON();
      } catch {
        body = postData;
      }
    }
    requests.push({ method, path, query: url.searchParams, body });

    if (path === `/books/${book.id}` && method === 'GET') {
      return json(route, book);
    }
    if (path === `/books/${book.id}/progress` && method === 'GET') {
      return json(route, { progress: 0, position: 0, location: null });
    }
    if (path === `/books/${book.id}/bookmarks` && method === 'GET') {
      return json(route, []);
    }
    if (path === `/books/${book.id}/chapters/chapter-1/generate/subtitles` && method === 'POST') {
      return json(route, {
        status: 'completed',
        subtitle_path: '/subtitles/chapter_0001.srt',
        chapter_id: 'chapter-1',
      });
    }
    if (path === `/books/${book.id}/generate/subtitles` && method === 'POST') {
      return json(route, {
        status: 'completed',
        results: [{ chapter_id: 'chapter-1', status: 'completed' }],
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
            words: [
              { start: 0, end: 10, text: 'Generated' },
              { start: 10, end: 20, text: 'subtitle' },
              { start: 20, end: 30, text: 'text' },
            ],
          },
        ],
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
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
}
