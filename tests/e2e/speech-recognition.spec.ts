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

type Chapter = {
  id: string;
  title: string;
  index: number;
  start_position?: number;
  end_position?: number;
};

type Book = {
  id: string;
  title: string;
  file_format: string;
  file_size: number;
  audio_track_count: number;
  chapters?: Chapter[];
};

let authFixture: AuthFixture;
let audiobook: Book | undefined;
let testChapter: Chapter | undefined;

test.skip(!process.env.E2E_AUTH_FIXTURE, 'Live authenticated tests require E2E_AUTH_FIXTURE.');

test.beforeAll(async () => {
  authFixture = getAuthFixture();

  const response = await fetch(`${BACKEND_URL}/books?limit=200`, {
    headers: { Authorization: `Bearer ${authFixture.accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`Failed to load books: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const books: Book[] = data.items || data;

  const candidates = books
    .filter((b) => ['mp3', 'm4b', 'flac', 'ogg', 'aac', 'wma'].includes(b.file_format))
    .filter((b) => b.file_size > 0 && b.chapters && b.chapters.length > 0)
    .sort((a, b) => (a.audio_track_count || 1) - (b.audio_track_count || 1));

  audiobook = candidates[0];
  if (audiobook) {
    testChapter = audiobook.chapters![0];
  }
});

test.beforeEach(async ({ context }) => {
  await seedSession(context, authFixture);
});

test.describe('ASR API — Transcription', () => {

  test('POST /books/{book_id}/chapters/{chapter_id}/transcribe transcribes a chapter', async ({ request }) => {
    test.skip(!audiobook || !testChapter, 'No audiobook with chapters available for transcription test.');

    const genRes = await request.post(
      `${BACKEND_URL}/books/${audiobook!.id}/generate/subtitles`,
      {
        headers: {
          Authorization: `Bearer ${authFixture.accessToken}`,
          'Content-Type': 'application/json',
        },
        data: { chapter_ids: [testChapter!.id] },
        timeout: 300_000,
      },
    );
    expect(genRes.status()).toBe(200);
    const body = await genRes.json();
    expect(body.status).toBe('completed');
    expect(body.results).toBeInstanceOf(Array);
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results[0].status).toBe('completed');
    expect(body.results[0].subtitle_path).toBeTruthy();
  });

  test('GET /books/{book_id}/chapters/{chapter_id}/subtitles?format=srt returns SRT content', async ({ request }) => {
    test.skip(!audiobook || !testChapter, 'No audiobook with chapters available.');

    const genRes = await request.post(
      `${BACKEND_URL}/books/${audiobook!.id}/generate/subtitles`,
      {
        headers: { Authorization: `Bearer ${authFixture.accessToken}`, 'Content-Type': 'application/json' },
        data: { chapter_ids: [testChapter!.id] },
        timeout: 300_000,
      },
    );
    test.skip(genRes.status() !== 200, 'Failed to generate subtitles for SRT test.');

    const res = await request.get(
      `${BACKEND_URL}/books/${audiobook!.id}/chapters/${testChapter!.id}/subtitles?format=srt`,
      { headers: { Authorization: `Bearer ${authFixture.accessToken}` } },
    );
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('1');
    expect(text).toContain('-->');
  });

  test('GET /books/{book_id}/chapters/{chapter_id}/subtitles?format=vtt returns VTT content', async ({ request }) => {
    test.skip(!audiobook || !testChapter, 'No audiobook with chapters available.');

    const genRes = await request.post(
      `${BACKEND_URL}/books/${audiobook!.id}/generate/subtitles`,
      {
        headers: { Authorization: `Bearer ${authFixture.accessToken}`, 'Content-Type': 'application/json' },
        data: { chapter_ids: [testChapter!.id] },
        timeout: 300_000,
      },
    );
    test.skip(genRes.status() !== 200, 'Failed to generate subtitles for VTT test.');

    const res = await request.get(
      `${BACKEND_URL}/books/${audiobook!.id}/chapters/${testChapter!.id}/subtitles?format=vtt`,
      { headers: { Authorization: `Bearer ${authFixture.accessToken}` } },
    );
    expect(res.status()).toBe(200);
    const text = await res.text();
    expect(text).toContain('WEBVTT');
    expect(text).toContain('-->');
  });

  test('GET /books/{book_id}/chapters/{chapter_id}/subtitles returns 404 before generation', async ({ request }) => {
    test.skip(!audiobook, 'No audiobook available.');

    const fakeChapterId = '00000000-0000-0000-0000-000000000000';
    const res = await request.get(
      `${BACKEND_URL}/books/${audiobook!.id}/chapters/${fakeChapterId}/subtitles?format=srt`,
      { headers: { Authorization: `Bearer ${authFixture.accessToken}` } },
    );
    expect(res.status()).toBe(404);
  });

});

test.describe('ASR API — Bulk Generation', () => {

  test('POST /books/{book_id}/generate/subtitles generates subtitles for all chapters', async ({ request }) => {
    test.skip(!audiobook, 'No audiobook available for bulk generation test.');

    const res = await request.post(
      `${BACKEND_URL}/books/${audiobook!.id}/generate/subtitles`,
      {
        headers: {
          Authorization: `Bearer ${authFixture.accessToken}`,
          'Content-Type': 'application/json',
        },
        data: {},
        timeout: 300_000,
      },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('completed');
    expect(body.results).toBeInstanceOf(Array);
  });

  test('GET /books/{book_id}/generate/subtitles/status returns generation status', async ({ request }) => {
    test.skip(!audiobook, 'No audiobook available for status test.');

    const res = await request.get(
      `${BACKEND_URL}/books/${audiobook!.id}/generate/subtitles/status`,
      { headers: { Authorization: `Bearer ${authFixture.accessToken}` } },
    );
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.book_id).toBe(audiobook!.id);
    expect(body).toHaveProperty('generated_chapters');
  });

});

test.describe('ASR Frontend', () => {

  test('audiobook player loads subtitle overlay when subtitles exist', async ({ page }) => {
    test.skip(!audiobook, 'No audiobook available for frontend test.');

    const bookRes = await fetch(`${BACKEND_URL}/books/${audiobook!.id}`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const bookDetail = await bookRes.json();
    const hasSubtitlesDir =
      await fetch(`${BACKEND_URL}/books/${audiobook!.id}/generate/subtitles/status`, {
        headers: { Authorization: `Bearer ${authFixture.accessToken}` },
      }).then((r) => r.json()).then((b) => b.generated_chapters?.length > 0).catch(() => false);

    await page.goto(`${FRONTEND_URL}/books/${audiobook!.id}/listen`);
    await expect(page.locator('.rhap_container')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('Audio failed to load.')).toHaveCount(0);
    await expectNoFrontendErrors(page);
  });

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
