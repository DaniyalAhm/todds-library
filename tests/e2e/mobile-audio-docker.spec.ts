import { expect, test, devices } from '@playwright/test';
import { createRequire } from 'node:module';

const frontendRequire = createRequire(`${process.cwd()}/apps/frontend/package.json`);
const { encode } = frontendRequire('next-auth/jwt') as {
  encode: (params: { secret: string; token: Record<string, unknown>; maxAge: number }) => Promise<string>;
};

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3330';
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'change_me_in_production';
const BOOK_ID = process.env.E2E_MOBILE_AUDIO_BOOK_ID;
const ACCESS_TOKEN = process.env.E2E_MOBILE_AUDIO_ACCESS_TOKEN;
const USER_ID = process.env.E2E_MOBILE_AUDIO_USER_ID || 'mobile-regression-user';
const USERNAME = process.env.E2E_MOBILE_AUDIO_USERNAME || 'mobile-regression';
const PASSWORD = process.env.E2E_MOBILE_AUDIO_PASSWORD;

function sanitizeUrl(value: string): string {
  const url = new URL(value);
  if (url.searchParams.has('access_token')) {
    url.searchParams.set('access_token', '<redacted>');
  }
  return url.toString();
}

test.use({
  ...devices['Pixel 5'],
  permissions: [],
});

test('Android Chrome uses direct audio and backend keeps ranged reconnects alive', async ({ page, context }) => {
  test.skip(!BOOK_ID, 'Set E2E_MOBILE_AUDIO_BOOK_ID.');

  let accessToken = ACCESS_TOKEN;
  if (PASSWORD) {
    await page.goto(`${FRONTEND_URL}/login`);
    await page.getByLabel('Username').fill(USERNAME);
    await page.getByLabel('Password').fill(PASSWORD);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

    const session = await page.evaluate(async () => {
      const response = await fetch('/api/auth/session');
      return response.json() as Promise<{ accessToken?: string }>;
    });
    accessToken = session.accessToken;
  } else if (ACCESS_TOKEN) {
    const sessionToken = await encode({
      secret: NEXTAUTH_SECRET,
      token: {
        sub: USER_ID,
        id: USER_ID,
        name: USERNAME,
        email: '',
        isAdmin: false,
        accessToken: ACCESS_TOKEN,
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
  expect(accessToken, 'backend access token').toBeTruthy();

  const audioResponses: Array<{
    status: number;
    acceptRanges: string | null;
    contentRange: string | null;
    contentLength: string | null;
    requestRange: string | null;
    url: string;
  }> = [];
  const audioRequests: Array<{
    range: string | null;
    url: string;
  }> = [];

  page.on('request', (request) => {
    if (!request.url().includes(`/backend-api/audiobooks/${BOOK_ID}/download`)) return;
    audioRequests.push({
      range: request.headers()['range'] ?? null,
      url: sanitizeUrl(request.url()),
    });
  });

  page.on('response', async (response) => {
    if (!response.url().includes(`/backend-api/audiobooks/${BOOK_ID}/download`)) return;
    audioResponses.push({
      status: response.status(),
      acceptRanges: response.headers()['accept-ranges'] ?? null,
      contentRange: response.headers()['content-range'] ?? null,
      contentLength: response.headers()['content-length'] ?? null,
      requestRange: response.request().headers()['range'] ?? null,
      url: sanitizeUrl(response.url()),
    });
  });

  await page.goto(`${FRONTEND_URL}/books/${BOOK_ID}/listen`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });

  const audio = page.locator('audio');
  await expect(audio).toHaveAttribute('src', /\/backend-api\/audiobooks\/.*\/download/, { timeout: 30_000 });
  await expect(audio).not.toHaveAttribute('src', /\/stream/);

  await audio.evaluate((element) => {
    const media = element as HTMLAudioElement;
    media.muted = true;
    return media.play();
  });
  await expect.poll(async () =>
    audio.evaluate((element) => (element as HTMLAudioElement).currentTime)
  ).toBeGreaterThan(0);

  const rangeResult = await page.evaluate(async ({ bookId, accessToken }) => {
    const response = await fetch(`/backend-api/audiobooks/${bookId}/download?access_token=${encodeURIComponent(accessToken)}`, {
      headers: {
        Range: 'bytes=2-8193',
      },
      cache: 'no-store',
    });
    const body = await response.arrayBuffer();
    return {
      status: response.status,
      acceptRanges: response.headers.get('accept-ranges'),
      contentRange: response.headers.get('content-range'),
      contentLength: response.headers.get('content-length'),
      cacheControl: response.headers.get('cache-control'),
      bodyBytes: body.byteLength,
    };
  }, { bookId: BOOK_ID, accessToken });

  expect(rangeResult).toEqual({
    status: 206,
    acceptRanges: 'bytes',
    contentRange: expect.stringMatching(/^bytes 2-8193\/\d+$/),
    contentLength: '8192',
    cacheControl: 'no-store',
    bodyBytes: 8192,
  });

  expect(audioResponses.some((response) => response.acceptRanges === 'bytes')).toBe(true);
  console.log(JSON.stringify({ audioRequests, audioResponses }, null, 2));
});

test('Android resume reconnects when Chrome pauses audio while hidden', async ({ page }) => {
  test.skip(!BOOK_ID || !PASSWORD, 'Set E2E_MOBILE_AUDIO_BOOK_ID and disposable login credentials.');

  await page.goto(`${FRONTEND_URL}/login`);
  await page.getByLabel('Username').fill(USERNAME);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  await page.goto(`${FRONTEND_URL}/books/${BOOK_ID}/listen`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('audio')).toHaveAttribute('src', /\/backend-api\/audiobooks\/.*\/download/, { timeout: 30_000 });

  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('audio element missing');
    (window as unknown as { __loadCalls: number }).__loadCalls = 0;
    const originalLoad = audio.load.bind(audio);
    audio.load = () => {
      (window as unknown as { __loadCalls: number }).__loadCalls += 1;
      originalLoad();
    };
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => false });
    Object.defineProperty(audio, 'ended', { configurable: true, get: () => false });
    Object.defineProperty(audio, 'currentTime', { configurable: true, get: () => 8 });
    audio.play = () => Promise.resolve();
    audio.dispatchEvent(new Event('play'));
  });

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  // This is the Android failure mode we need to handle: while the tab is
  // hidden/minimized, Chrome/the OS can pause the media element after the
  // network stream drops. The app still intended to keep background playback.
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    if (!audio) throw new Error('audio element missing');
    Object.defineProperty(audio, 'paused', { configurable: true, get: () => true });
    audio.dispatchEvent(new Event('pause'));
  });

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await expect.poll(async () =>
    page.evaluate(() => (window as unknown as { __loadCalls?: number }).__loadCalls ?? 0)
  ).toBeGreaterThan(0);
});
