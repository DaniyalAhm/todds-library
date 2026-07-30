import { test, expect, type Page, type Route } from '@playwright/test';

const book = {
  id: '00000000-0000-4000-8000-000000000101',
  title: 'Mock Audiobook',
  author: 'Example Author',
  format: 'mp3',
  file_format: 'mp3',
  file_size: 1024,
  file_path: '/books/mock-audiobook.mp3',
  cover: null,
  cover_url: null,
  download_url: '/backend-api/books/00000000-0000-4000-8000-000000000101/download',
  audio_download_url: '/backend-api/audiobooks/00000000-0000-4000-8000-000000000101/download',
  stream_url: '/backend-api/audiobooks/00000000-0000-4000-8000-000000000101/stream',
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
  description: 'Mock audiobook for subtitle generation checks.',
  created_at: '2026-07-25T00:00:00Z',
  updated_at: '2026-07-25T00:00:00Z',
  chapters: [
    { id: 'chapter-1', title: 'Chapter 1', index: 1, start_position: 0 },
    { id: 'chapter-2', title: 'Chapter 2', index: 2, start_position: 60 },
  ],
};

test('audiobook player generates subtitles for the current chapter', async ({ page }) => {
  const requests: Array<{ path: string; method: string }> = [];
  await mockBackend(page, requests);

  await page.goto(`/books/${book.id}/listen`);
  await expect(page.getByRole('heading', { name: book.title, level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Generate Subtitles' }).click();

  await expect.poll(() =>
    requests.some((request) =>
      request.method === 'POST' &&
      request.path === `/books/${book.id}/chapters/chapter-1/generate/subtitles`
    )
  ).toBe(true);
  await expect(page.getByText('Generated subtitle text')).toBeVisible();
  await expect(page.getByText('Subtitles generated')).toBeVisible();
});

test('audiobook player highlights active subtitle words from JSON subtitles', async ({ page }) => {
  const requests: Array<{ path: string; method: string }> = [];
  await mockBackend(page, requests);

  await page.goto(`/books/${book.id}/listen`);

  await expect(page.getByText('Generated subtitle text')).toBeVisible();
  await expect(page.locator('[data-subtitle-word-active="true"]')).toContainText('Generated');

  await page.getByRole('button', { name: 'Panel' }).click();
  await expect(page.getByRole('button', { name: 'Overlay' })).toBeVisible();

  await page.getByRole('button', { name: 'Captions' }).click();
  await expect(page.getByText('Generated subtitle text')).toHaveCount(0);
});

test('audiobook player falls back to SRT subtitles when JSON is unavailable', async ({ page }) => {
  const requests: Array<{ path: string; method: string }> = [];
  await mockBackend(page, requests, { jsonSubtitles: false });

  await page.goto(`/books/${book.id}/listen`);

  await expect(page.getByText('Generated subtitle text')).toBeVisible();
  await expect.poll(() =>
    requests.some((request) =>
      request.method === 'GET' &&
      request.path === `/books/${book.id}/chapters/chapter-1/subtitles`
    )
  ).toBe(true);
});

async function mockBackend(
  page: Page,
  requests: Array<{ path: string; method: string }>,
  options: { jsonSubtitles?: boolean } = {}
) {
  const jsonSubtitles = options.jsonSubtitles ?? true;

  await page.route('**/backend-api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/backend-api', '');
    const method = route.request().method();
    requests.push({ path, method });

    if (path === `/books/${book.id}`) {
      return json(route, book);
    }
    if (path === `/books/${book.id}/progress`) {
      return json(route, { progress: 0, position: 0, location: null });
    }
    if (path === `/books/${book.id}/chapters/chapter-1/generate/subtitles` && method === 'POST') {
      return json(route, {
        status: 'completed',
        subtitle_path: '/books/subtitles/chapter_0001.srt',
        chapter_id: 'chapter-1',
      });
    }
    if (path === `/books/${book.id}/chapters/chapter-1/subtitles` && url.searchParams.get('format') === 'json') {
      if (!jsonSubtitles) {
        return json(route, { detail: 'Subtitles not yet generated' }, 404);
      }
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
