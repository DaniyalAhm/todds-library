import { test, expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const frontendRequire = createRequire(`${process.cwd()}/apps/frontend/package.json`);
const { encode } = frontendRequire('next-auth/jwt') as {
  encode: (params: { secret: string; token: Record<string, unknown>; maxAge: number }) => Promise<string>;
};

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://localhost:3330';
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
  file_format: string;
  has_ebook?: boolean;
  has_audiobook?: boolean;
};

test.describe('responsive authenticated UI', () => {
  let authFixture: AuthFixture | undefined;
  let books: Book[];
  const e2eUsername = process.env.E2E_USERNAME;
  const e2ePassword = process.env.E2E_PASSWORD;
  const useMocks = process.env.E2E_USE_MOCKS === '1';

  test.beforeAll(async () => {
    authFixture = useMocks
      ? mockAuthFixture
      : process.env.E2E_AUTH_FIXTURE
        ? JSON.parse(process.env.E2E_AUTH_FIXTURE)
        : e2eUsername && e2ePassword
          ? undefined
          : getAuthFixture();
    books = useMocks
      ? mockBooks
      : process.env.E2E_BOOKS_FIXTURE
        ? JSON.parse(process.env.E2E_BOOKS_FIXTURE)
        : getBooksFixture();
    expect(books.length).toBeGreaterThan(0);
  });

  test.beforeEach(async ({ context, page }) => {
    if (useMocks) {
      await mockBackend(page);
    }
    if (authFixture) {
      await seedSession(context, authFixture);
    }
  });

  for (const viewport of [
    { name: 'phone', width: 390, height: 844 },
    { name: 'tablet', width: 768, height: 1024 },
  ]) {
    test(`${viewport.name} layout has usable navigation, catalog, detail, reader, and player`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      if (!authFixture) {
        await login(page, e2eUsername!, e2ePassword!);
      }

      await page.goto(`${FRONTEND_URL}/dashboard`);
      await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      if (viewport.width < 768) {
        await page.getByRole('button', { name: 'Open navigation' }).click();
        await expect(page.getByRole('link', { name: /Books/ })).toBeVisible();
        await page.getByRole('link', { name: /Books/ }).click();
      } else {
        await page.goto(`${FRONTEND_URL}/books`);
      }

      await expect(page.getByRole('heading', { name: 'Books' })).toBeVisible();
      await expect(page.getByText(books[0].title, { exact: false })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      const mixed = books.find((book) => book.has_ebook && book.has_audiobook);
      const ebook = mixed ?? books.find((book) => book.has_ebook || book.file_format === 'epub');
      const audiobook =
        mixed ??
        books.find((book) => book.has_audiobook || ['mp3', 'm4b', 'flac', 'ogg', 'aac', 'wma'].includes(book.file_format));
      const detailBook = mixed ?? ebook ?? audiobook ?? books[0];

      await page.goto(`${FRONTEND_URL}/books/${detailBook.id}`);
      await expect(page.getByRole('heading', { name: detailBook.title })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      if (ebook) {
        await page.goto(`${FRONTEND_URL}/books/${ebook.id}/read`);
        await expect(page.getByRole('heading', { name: ebook.title })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }

      if (audiobook) {
        await page.goto(`${FRONTEND_URL}/books/${audiobook.id}/listen`);
        await expect(page.getByRole('heading', { name: audiobook.title, level: 1 })).toBeVisible();
        await expect(page.locator('.rhap_container')).toBeVisible();
        await expect(page.locator('audio')).toHaveAttribute('src', /\/audiobooks\/.*\/download.*track=0/);
        await expectNoHorizontalOverflow(page);
      }

      if (authFixture?.isAdmin || e2eUsername) {
        await page.goto(`${FRONTEND_URL}/admin`);
        await expect(page.getByRole('heading', { name: 'Admin Dashboard' })).toBeVisible();
        await page.getByRole('button', { name: 'Add Directory Library' }).click();
        await expect(page.getByRole('heading', { name: 'Add Library' })).toBeVisible();
        await expectNoHorizontalOverflow(page);
      }
    });
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

async function login(page: Page, username: string, password: string) {
  await page.goto(`${FRONTEND_URL}/login`);
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });
}

function getAuthFixture(): AuthFixture {
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

  const output = execFileSync('docker', ['compose', 'exec', '-T', 'backend', 'python', '-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output) as AuthFixture;
}

function getBooksFixture(): Book[] {
  const script = `
import asyncio, json
from sqlalchemy import select
from app.database import AsyncSessionLocal
from app.models.book import Book

async def main():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Book).order_by(Book.updated_at.desc()).limit(200))
        books = result.scalars().all()
        print(json.dumps([
            {
                "id": str(book.id),
                "title": book.title,
                "file_format": book.file_format.value,
                "has_ebook": book.has_ebook,
                "has_audiobook": book.has_audiobook,
            }
            for book in books
        ]))

asyncio.run(main())
`;

  const output = execFileSync('docker', ['compose', 'exec', '-T', 'backend', 'python', '-c', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output) as Book[];
}

async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

const mockAuthFixture: AuthFixture = {
  accessToken: 'mock-access-token',
  userId: '00000000-0000-4000-8000-000000000001',
  username: 'mobile_admin',
  email: 'mobile-admin@example.local',
  isAdmin: true,
};

const mockBooks: Book[] = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    title: 'In the Realm of Hungry Ghosts',
    file_format: 'epub',
    has_ebook: true,
    has_audiobook: true,
  },
];

async function mockBackend(page: Page) {
  await page.route('**/backend-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/backend-api', '');
    const book = mockBookDetail;

    if (path === '/auth/setup-status') {
      return json(route, { needs_setup: false });
    }
    if (path === '/books') {
      return json(route, { items: [book], total: 1, limit: 200, offset: 0 });
    }
    if (path === `/books/${book.id}`) {
      return json(route, book);
    }
    if (path === `/books/${book.id}/progress`) {
      return json(route, { progress: 0.25, position: 120, location: null });
    }
    if (path === `/books/${book.id}/bookmarks`) {
      return json(route, []);
    }
    if (path === `/books/${book.id}/download`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/epub+zip',
        body: Buffer.from('mock epub'),
      });
    }
    if (path === `/audiobooks/${book.id}/download`) {
      return route.fulfill({
        status: 200,
        contentType: 'audio/mpeg',
        body: Buffer.from('mock audio'),
      });
    }
    if (path === `/audiobooks/${book.id}/stream`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n',
      });
    }
    if (path === '/libraries') {
      return json(route, [
        {
          id: '00000000-0000-4000-8000-000000000201',
          name: 'Books',
          path: '/books',
          type: 'mixed',
          book_count: 1,
        },
      ]);
    }
    if (path === '/libraries/directories') {
      return json(route, {
        root: '/books',
        current: '/books',
        parent: null,
        items: [
          { name: 'Gabor Mate MD', path: '/books/Gabor Mate MD', has_children: true },
        ],
      });
    }

    return json(route, {});
  });
  await page.route('**/api/auth/session', async (route) => json(route, {
    user: {
      id: mockAuthFixture.userId,
      name: mockAuthFixture.username,
      email: mockAuthFixture.email,
      isAdmin: mockAuthFixture.isAdmin,
    },
    accessToken: mockAuthFixture.accessToken,
    expires: '2099-01-01T00:00:00.000Z',
  }));
}

function json(route: Route, value: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
}

const mockBookDetail = {
  id: mockBooks[0].id,
  title: mockBooks[0].title,
  author: 'Gabor Mate, M.D.',
  format: 'epub',
  file_format: 'epub',
  file_size: 1024,
  file_path: '/books/Gabor Mate MD/In the Realm of Hungry Ghosts/In the Realm of Hungry Ghosts.epub',
  cover: null,
  cover_url: null,
  download_url: '/backend-api/books/00000000-0000-4000-8000-000000000101/download',
  audio_download_url: '/backend-api/audiobooks/00000000-0000-4000-8000-000000000101/download',
  stream_url: '/backend-api/audiobooks/00000000-0000-4000-8000-000000000101/stream',
  has_ebook: true,
  has_audiobook: true,
  ebook_format: 'epub',
  audiobook_format: 'mp3',
  duration: 3600,
  page_count: 320,
  publisher: 'Mock Publisher',
  isbn: '9780000000000',
  series: null,
  description: 'Mock mixed-media book for responsive layout checks.',
  created_at: '2026-07-25T00:00:00Z',
  updated_at: '2026-07-25T00:00:00Z',
  chapters: [
    { id: 'c1', title: 'Chapter 1', start_position: 0 },
    { id: 'c2', title: 'Chapter 2', start_position: 1800 },
  ],
};
