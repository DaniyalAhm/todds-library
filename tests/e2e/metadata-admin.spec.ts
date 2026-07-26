import { expect, test, type Page, type Route } from '@playwright/test';

const FRONTEND_URL = process.env.E2E_BASE_URL || 'http://localhost:3330';

type Book = {
  id: string;
  title: string;
  author?: string | null;
  description?: string | null;
  publisher?: string | null;
  isbn?: string | null;
  series?: string | null;
  asin?: string | null;
  file_format: string;
  cover_path?: string | null;
  format?: string;
};

const mockSession = {
  user: {
    id: '00000000-0000-4000-8000-000000000001',
    name: 'metadata-admin',
    email: 'metadata-admin@example.local',
    isAdmin: true,
  },
  accessToken: 'mock-access-token',
  expires: '2099-01-01T00:00:00.000Z',
};

const books: Book[] = [
  {
    id: '00000000-0000-4000-8000-000000000101',
    title: 'Cover Missing Book',
    author: null,
    description: null,
    publisher: null,
    isbn: null,
    series: null,
    asin: null,
    file_format: 'epub',
    cover_path: null,
    format: 'epub',
  },
  {
    id: '00000000-0000-4000-8000-000000000102',
    title: 'Already Enriched Book',
    author: 'Jane Author',
    description: 'Already has metadata.',
    publisher: 'Known Press',
    isbn: '9780000000000',
    series: null,
    asin: null,
    file_format: 'pdf',
    cover_path: '/covers/known.jpg',
    format: 'pdf',
  },
];

test('metadata admin page loads, applies metadata, and saves edits', async ({ page }) => {
  const requests: Array<{ path: string; method: string; body?: unknown }> = [];

  await mockAuth(page);
  await page.route('**/backend-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/backend-api', '');
    const method = route.request().method();
    const body = await requestBody(route);
    requests.push({ path, method, body });

    if (path === '/books' && method === 'GET') {
      const query = url.searchParams.get('search') || '';
      const items = books.filter((book) => {
        if (!query) return true;
        return [book.title, book.author, book.publisher, book.description].some((value) =>
          value?.toLowerCase().includes(query.toLowerCase()),
        );
      });
      return json(route, { items, total: items.length, limit: 50, offset: 0 });
    }

    if (path === '/metadata/lookup/00000000-0000-4000-8000-000000000101' && method === 'GET') {
      return json(route, {
        results: [
          {
            title: 'The Free Version',
            author: 'Cover Source',
            description: 'Fetched metadata with a cover image.',
            publisher: 'Metadata Press',
            source: 'openlibrary',
            cached: true,
            has_cover: true,
            cover_path: '/covers/00000000-0000-4000-8000-000000000101-openlibrary.jpg',
          },
        ],
      });
    }

    if (path === '/metadata/apply/00000000-0000-4000-8000-000000000101' && method === 'POST') {
      return json(route, {
        ...books[0],
        title: 'The Free Version',
        author: 'Cover Source',
        description: 'Fetched metadata with a cover image.',
        publisher: 'Metadata Press',
        cover_path: '/covers/00000000-0000-4000-8000-000000000101-openlibrary.jpg',
      });
    }

    if (path === '/metadata/refresh/00000000-0000-4000-8000-000000000101' && method === 'POST') {
      return json(route, books[0]);
    }

    if (path === '/metadata/00000000-0000-4000-8000-000000000101' && method === 'PUT') {
      const next = typeof body === 'object' && body ? (body as Record<string, unknown>) : {};
      return json(route, {
        ...books[0],
        ...next,
      });
    }

    return json(route, {});
  });

  await page.goto('/admin/metadata');
  await expect(page.getByRole('heading', { name: 'Metadata Management' })).toBeVisible();

  const bookCard = page.locator('div.rounded-lg.border').filter({ hasText: 'Cover Missing Book' }).first();
  await expect(bookCard).toBeVisible();

  await bookCard.getByRole('button').last().click();
  await page.getByLabel('Title').fill('Manually Edited Book');
  await page.getByLabel('Publisher').fill('Edited Press');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect.poll(() => findRequest(requests, '/metadata/00000000-0000-4000-8000-000000000101', 'PUT')).toBeTruthy();
  expect(findRequest(requests, '/metadata/00000000-0000-4000-8000-000000000101', 'PUT')?.body).toMatchObject({
    title: 'Manually Edited Book',
    publisher: 'Edited Press',
  });

  await bookCard.getByTitle('Load saved metadata').click();
  await expect(page.getByText('The Free Version', { exact: true })).toBeVisible();
  await expect(page.getByText('Cover')).toBeVisible();

  await page.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(() => findRequest(requests, '/metadata/apply/00000000-0000-4000-8000-000000000101', 'POST')).toBeTruthy();
  expect(findRequest(requests, '/metadata/apply/00000000-0000-4000-8000-000000000101', 'POST')?.body).toMatchObject({
    title: 'The Free Version',
    author: 'Cover Source',
    cover_path: '/covers/00000000-0000-4000-8000-000000000101-openlibrary.jpg',
  });

  await expect(page.getByText(/failed to load|not found|method not allowed/i)).toHaveCount(0);
});

async function mockAuth(page: Page) {
  await page.route('**/api/auth/session', async (route) => json(route, mockSession));
}

async function requestBody(route: Route): Promise<unknown> {
  const raw = route.request().postData();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function findRequest(requests: Array<{ path: string; method: string; body?: unknown }>, path: string, method: string) {
  return requests.find((request) => request.path === path && request.method === method);
}

function json(route: Route, value: unknown) {
  return route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(value),
  });
}
