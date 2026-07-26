import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const frontendRequire = createRequire(`${process.cwd()}/apps/frontend/package.json`);
const { encode } = frontendRequire('next-auth/jwt') as {
  encode: (params: { secret: string; token: Record<string, unknown>; maxAge: number }) => Promise<string>;
};

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://localhost:3330';
const BACKEND_URL = process.env.E2E_API_URL || 'http://localhost:8830/api';
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'change_me_in_production';

type AuthFixture = {
  accessToken: string;
  userId: string;
  username: string;
  email: string;
  isAdmin: boolean;
};

type Book = {
  id: string;
  title: string;
  author?: string | null;
  file_format: string;
};

let authFixture: AuthFixture;
let allBooks: Book[];

test.skip(!process.env.E2E_AUTH_FIXTURE, 'Live authenticated tests require E2E_AUTH_FIXTURE.');

test.beforeAll(async () => {
  authFixture = getAuthFixture();
  const response = await fetch(`${BACKEND_URL}/books?limit=200`, {
    headers: { Authorization: `Bearer ${authFixture.accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to load books for E2E setup: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  allBooks = data.items;
  expect(allBooks.length).toBeGreaterThan(0);
});

test.beforeEach(async ({ context }) => {
  await seedSession(context, authFixture);
});

test('catalog loads real books and search filters results', async ({ page }) => {
  const searchableBook = allBooks.find((book) => book.title.includes('Project Hail Mary')) ?? allBooks[0];

  await page.goto('/books');
  await expect(page.getByRole('heading', { name: 'Books' })).toBeVisible();
  await expect(page.getByText(searchableBook.title, { exact: false })).toBeVisible();

  await page.getByPlaceholder('Search books...').fill(searchableBook.title);
  await expect(page.getByText(searchableBook.title, { exact: false })).toBeVisible();
  await expectNoFrontendErrors(page);
});

test('epub reader opens an authenticated book file', async ({ page }) => {
  const ebook = allBooks.find((book) => book.file_format === 'epub');
  test.skip(!ebook, 'No EPUB book exists in the current library.');

  const downloadResponse = page.waitForResponse(
    (response) => response.url().includes(`/api/books/${ebook!.id}/download`) && response.status() === 200,
    { timeout: 60_000 },
  );

  await page.goto(`/books/${ebook!.id}/read`);
  await expect(page.getByRole('heading', { name: ebook!.title })).toBeVisible();
  await downloadResponse;
  await expect(page.getByText('Book file failed to load.')).toHaveCount(0);
  await expectNoFrontendErrors(page);
});

test('audiobook player opens and fetches authenticated HLS playback', async ({ page }) => {
  const audiobook =
    allBooks.find((book) => book.title.includes('Project Hail Mary')) ??
    allBooks.find((book) => ['mp3', 'm4b', 'flac', 'ogg', 'aac', 'wma'].includes(book.file_format));
  test.skip(!audiobook, 'No audiobook exists in the current library.');

  const playlistResponse = page.waitForResponse(
    (response) => response.url().includes(`/api/audiobooks/${audiobook!.id}/stream`) && response.status() === 200,
    { timeout: 120_000 },
  );

  await page.goto(`/books/${audiobook!.id}/listen`);
  await expect(page.getByRole('heading', { name: audiobook!.title })).toBeVisible();
  await expect(page.locator('.rhap_container')).toBeVisible();
  await playlistResponse;
  await expect(page.getByText('Audio failed to load.')).toHaveCount(0);
  await expectNoFrontendErrors(page);
});

test('protected media endpoints are reachable with the browser session token', async ({ request }) => {
  const ebook = allBooks.find((book) => book.file_format === 'epub');
  const audiobook = allBooks.find((book) => ['mp3', 'm4b', 'flac', 'ogg', 'aac', 'wma'].includes(book.file_format));

  if (ebook) {
    const epubResponse = await request.get(`${BACKEND_URL}/books/${ebook.id}/download`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    expect(epubResponse.status()).toBe(200);
    expect(epubResponse.headers()['content-type']).toContain('application/epub+zip');
  }

  if (audiobook) {
    const playlistResponse = await request.get(`${BACKEND_URL}/audiobooks/${audiobook.id}/stream`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
      timeout: 120_000,
    });
    expect(playlistResponse.status()).toBe(200);
    expect(await playlistResponse.text()).toContain('#EXTM3U');
  }
});

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

function getAuthFixture(): AuthFixture {
  if (process.env.E2E_AUTH_FIXTURE) {
    return JSON.parse(process.env.E2E_AUTH_FIXTURE) as AuthFixture;
  }

  const script = `
import asyncio, json
from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.user import User
from app.services.auth_service import create_user_jwt

async def main():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).order_by(User.is_admin.desc(), User.created_at.asc()).limit(1))
        user = result.scalar_one()
        print(json.dumps({
            "accessToken": create_user_jwt(user),
            "userId": str(user.id),
            "username": user.username,
            "email": user.email or "",
            "isAdmin": user.is_admin,
        }))

asyncio.run(main())
`;

  const output = execFileSync(
    'docker',
    ['compose', 'exec', '-T', 'backend', 'python', '-c', script],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return JSON.parse(output) as AuthFixture;
}

async function expectNoFrontendErrors(page: Page) {
  await expect(page.getByText(/failed to load|not found|invalid username|method not allowed/i)).toHaveCount(0);
}
