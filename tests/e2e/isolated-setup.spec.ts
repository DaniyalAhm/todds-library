import { test, expect, type Page } from '@playwright/test';

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://localhost:3331';
const BACKEND_URL = process.env.E2E_API_URL || 'http://localhost:8831/api';
const E2E_USERNAME = 'e2eadmin';
const E2E_PASSWORD = 'e2e-password';

type Book = {
  id: string;
  title: string;
  file_format: string;
  file_size?: number;
  has_ebook: boolean;
  has_audiobook: boolean;
  ebook_format?: string | null;
  audiobook_format?: string | null;
};

test('first-time setup, library add, catalog, EPUB reader, and audiobook player work', async ({ page, request }) => {
  test.setTimeout(240_000);

  await page.goto(FRONTEND_URL);
  await expect(page).toHaveURL(/\/register$/);
  await expect(page.getByRole('heading', { name: 'Set Up Administrator' })).toBeVisible();

  await page.getByLabel('Username').fill(E2E_USERNAME);
  await page.getByLabel('Password', { exact: true }).fill(E2E_PASSWORD);
  await page.getByLabel('Confirm Password').fill(E2E_PASSWORD);
  await page.getByRole('button', { name: 'Create Administrator' }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

  const loginResponse = await request.post(`${BACKEND_URL}/auth/login`, {
    data: { username: E2E_USERNAME, password: E2E_PASSWORD },
  });
  expect(loginResponse.status()).toBe(200);
  const { access_token: accessToken } = await loginResponse.json();

  await page.goto(`${FRONTEND_URL}/admin`);
  await expect(page.getByRole('heading', { name: 'Admin Dashboard' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Directory Library' }).click();
  await page.getByPlaceholder('My Books').fill('E2E Books');
  await page.getByPlaceholder('/books').fill('/books');
  await page.getByRole('button', { name: 'Add Manual Library' }).click();
  await expect(page.getByText('/books', { exact: true })).toBeVisible({ timeout: 120_000 });

  const books = await waitForBooks(accessToken);
  const mixedBook = books.find((book) => book.has_ebook && book.has_audiobook);
  expect(mixedBook).toBeTruthy();
  const ebook = mixedBook ?? books.find((book) => book.has_ebook || book.file_format === 'epub');
  const audiobook = mixedBook ?? books
    .filter((book) => book.has_audiobook || ['mp3', 'm4b', 'flac', 'ogg', 'aac', 'wma'].includes(book.file_format))
    .sort((a, b) => (a.file_size ?? Number.MAX_SAFE_INTEGER) - (b.file_size ?? Number.MAX_SAFE_INTEGER))[0];

  await page.goto(`${FRONTEND_URL}/books`);
  await expect(page.getByRole('heading', { name: 'Books' })).toBeVisible();
  await expect(page.getByText(books[0].title, { exact: false })).toBeVisible();

  if (mixedBook) {
    await page.goto(`${FRONTEND_URL}/books/${mixedBook.id}`);
    await expect(page.getByRole('heading', { name: mixedBook.title })).toBeVisible();
    await expect(page.getByText('Ebook + Audiobook')).toBeVisible();
    await expect(page.getByRole('button', { name: /Read Online|Continue Reading/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Listen|Continue Listening/ })).toBeVisible();
  }

  if (ebook) {
    const epubDownload = await request.get(`${BACKEND_URL}/books/${ebook.id}/download`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 60_000,
    });
    expect(epubDownload.status()).toBe(200);
    expect(epubDownload.headers()['content-type']).toContain('application/epub+zip');

    await page.goto(`${FRONTEND_URL}/books/${ebook.id}/read`);
    await expect(page.getByRole('heading', { name: ebook.title })).toBeVisible();
    await expect(page.getByText('Book file failed to load.')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(1, { timeout: 60_000 });
  }

  if (audiobook) {
    const hlsPlaylist = await request.get(`${BACKEND_URL}/audiobooks/${audiobook.id}/stream`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 120_000,
    });
    expect(hlsPlaylist.status()).toBe(200);
    expect(await hlsPlaylist.text()).toContain('#EXTM3U');

    await page.goto(`${FRONTEND_URL}/books/${audiobook.id}/listen`);
    await expect(page.getByRole('heading', { name: audiobook.title, level: 1 })).toBeVisible();
    await expect(page.locator('.rhap_container')).toBeVisible();
    await expect(page.getByText('Audio failed to load.')).toHaveCount(0);
  }

  await expectNoFrontendErrors(page);
});

async function waitForBooks(accessToken: string): Promise<Book[]> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${BACKEND_URL}/books?limit=200`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const data = await response.json();
      if (data.items?.length > 0) {
        return data.items;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('Timed out waiting for scanned books.');
}

async function expectNoFrontendErrors(page: Page) {
  await expect(page.getByText(/failed to load|not found|invalid username|method not allowed/i)).toHaveCount(0);
}
