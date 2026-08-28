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

test('debug reconnect', async ({ browser }) => {
  const requests: Array<Req> = [];
  const context = await browser.newContext();
  await seedSession(context);
  const page = await context.newPage();
  page.on('console', (msg) => console.log('CONSOLE:', msg.type(), msg.text().slice(0, 300)));
  page.on('pageerror', (err) => console.log('PAGEERROR:', err.message));
  await mockBackend(page, requests);

  await page.goto(`/books/${book.id}/listen`);
  await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();
  await expect(page.locator('audio')).toHaveAttribute('src', /\/audiobooks\/.*\/download/);

  await page.evaluate(() => {
    let count = 0;
    const probe = setInterval(() => {
      count += 1;
      console.log('PROBE_TICK', count, document.visibilityState);
      if (count >= 6) clearInterval(probe);
    }, 1000);
    (window as unknown as { probe: () => void }).probe = () => clearInterval(probe);
  });

  const countDownloadRequests = () =>
    requests.filter((r) => r.method === 'GET' && r.path === `/audiobooks/${book.id}/download`).length;

  const initialDownloads = countDownloadRequests();
  console.log('initialDownloads', initialDownloads);

  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('audio element missing');
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 30 });
    audio.play = () => Promise.resolve();
    audio.dispatchEvent(new Event('play'));
  });
  await page.waitForTimeout(400);
  console.log('after play, downloads', countDownloadRequests());

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(2000);
    console.log(`t=${(i + 1) * 2}s downloads=${countDownloadRequests()}`);
  }
});

interface Req {
  path: string;
  method: string;
  search: string;
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
    { name: 'next-auth.session-token', value: sessionToken, url: FRONTEND_URL, httpOnly: true, sameSite: 'Lax', secure: false },
  ]);
}

async function mockBackend(page: Page, requests: Req[]) {
  await page.route('**/backend-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/backend-api', '');
    const method = route.request().method();
    requests.push({ path, method, search: url.search });
    if (path === `/books/${book.id}`) return json(route, book);
    if (path === `/books/${book.id}/progress`) return json(route, { progress: 0, position: 0, location: null });
    if (path === `/audiobooks/${book.id}/download`) {
      return route.fulfill({ status: 200, contentType: 'audio/mpeg', headers: { 'cache-control': 'no-store' }, body: Buffer.from('mock audio') });
    }
    return json(route, {});
  });
  await page.route('**/api/auth/session', async (route) => json(route, {
    user: { id: '00000000-0000-4000-8000-000000000001', name: 'mock-user', email: 'mock@example.local', isAdmin: false },
    accessToken: 'mock-access-token',
    expires: '2099-01-01T00:00:00.000Z',
  }));
}

function json(route: Route, value: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
}