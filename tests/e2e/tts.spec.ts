import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
  file_format: string;
  chapters?: { id: string; title: string; index: number }[];
};

let authFixture: AuthFixture;
let epubBook: Book | undefined;

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
  epubBook = books.find(
    (b) => b.file_format === 'epub' || b.title.endsWith('.epub')
  );
});

test.beforeEach(async ({ context }) => {
  await seedSession(context, authFixture);
});

test.describe('TTS API', () => {

  test('GET /tts/voices returns available voices', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/tts/voices`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    expect(res.status()).toBe(200);
    const voices = await res.json();
    expect(Array.isArray(voices)).toBe(true);
    expect(voices.length).toBeGreaterThanOrEqual(1);
    expect(voices[0]).toMatchObject({
      id: expect.any(String),
      name: expect.any(String),
      language: expect.any(String),
      is_cloned: expect.any(Boolean),
    });
  });

  test('POST /tts/voices/clone creates a cloned voice from uploaded audio', async ({ request }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tts-test-'));
    const wavPath = join(tmpDir, 'test_voice.wav');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ar', '22050', '-ac', '1',
      '-y', wavPath,
    ], { stdio: 'pipe' });

    const res = await request.post(`${BACKEND_URL}/tts/voices/clone`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
      multipart: {
        name: 'Test Clone Voice',
        audio: { name: 'test_voice.wav', mimeType: 'audio/wav', buffer: require('fs').readFileSync(wavPath) },
      },
    });
    unlinkSync(wavPath);

    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ voice_id: expect.any(String), name: 'Test Clone Voice' });

    const listRes = await request.get(`${BACKEND_URL}/tts/voices`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const voices = await listRes.json();
    const cloned = voices.find((v: any) => v.id === body.voice_id);
    expect(cloned).toBeDefined();
    expect(cloned.is_cloned).toBe(true);

    await request.delete(`${BACKEND_URL}/tts/voices/${body.voice_id}`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
  });

  test('DELETE /tts/voices/{voice_id} removes a cloned voice', async ({ request }) => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tts-test-'));
    const wavPath = join(tmpDir, 'del_voice.wav');
    execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-ar', '22050', '-ac', '1',
      '-y', wavPath,
    ], { stdio: 'pipe' });

    const createRes = await request.post(`${BACKEND_URL}/tts/voices/clone`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
      multipart: {
        name: 'Delete Test Voice',
        audio: { name: 'del_voice.wav', mimeType: 'audio/wav', buffer: require('fs').readFileSync(wavPath) },
      },
    });
    unlinkSync(wavPath);
    expect(createRes.status()).toBe(201);
    const { voice_id } = await createRes.json();

    const delRes = await request.delete(`${BACKEND_URL}/tts/voices/${voice_id}`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    expect(delRes.status()).toBe(204);

    const listRes = await request.get(`${BACKEND_URL}/tts/voices`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const voices = await listRes.json();
    expect(voices.find((v: any) => v.id === voice_id)).toBeUndefined();
  });

  test('POST /books/{book_id}/tts/synthesize returns audio/wav for valid text', async ({ request }) => {
    test.skip(!epubBook, 'No EPUB book available for TTS synthesis test.');

    const res = await request.post(`${BACKEND_URL}/books/${epubBook!.id}/tts/synthesize`, {
      headers: {
        Authorization: `Bearer ${authFixture.accessToken}`,
        'Content-Type': 'application/json',
      },
      data: { text: 'Hello, this is a test of the text to speech system.' },
    });
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('audio/wav');
    const body = await res.body();
    expect(body.length).toBeGreaterThan(100);
  });

  test('POST /books/{book_id}/tts/synthesize rejects empty text', async ({ request }) => {
    test.skip(!epubBook, 'No EPUB book available.');

    const res = await request.post(`${BACKEND_URL}/books/${epubBook!.id}/tts/synthesize`, {
      headers: {
        Authorization: `Bearer ${authFixture.accessToken}`,
        'Content-Type': 'application/json',
      },
      data: { text: '' },
    });
    expect(res.status()).toBe(400);
  });

  test('POST /books/{book_id}/generate/audio creates chapter audio for EPUB', async ({ request }) => {
    test.skip(!epubBook, 'No EPUB book available for audio generation.');

    const voicesRes = await request.get(`${BACKEND_URL}/tts/voices`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const voices = await voicesRes.json();
    const defaultVoice = voices[0]?.id;
    test.skip(!defaultVoice, 'No TTS voice available.');

    const res = await request.post(`${BACKEND_URL}/books/${epubBook!.id}/generate/audio`, {
      headers: {
        Authorization: `Bearer ${authFixture.accessToken}`,
        'Content-Type': 'application/json',
      },
      data: { voice_id: defaultVoice, chapter_indices: null },
      timeout: 180_000,
    });
    expect(res.status()).toBe(201);
    const entries: any[] = await res.json();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0]).toMatchObject({
      book_id: epubBook!.id,
      chapter_index: expect.any(Number),
      voice_id: defaultVoice,
      status: 'completed',
      file_path: expect.any(String),
    });
    expect(typeof entries[0].duration).toBe('number');

    const listRes = await request.get(`${BACKEND_URL}/books/${epubBook!.id}/generate/audio`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const listed: any[] = await listRes.json();
    expect(listed.length).toBeGreaterThanOrEqual(entries.length);
  });

  test('GET /books/{book_id}/generate/audio/download/{chapter_index} returns audio file', async ({ request }) => {
    test.skip(!epubBook, 'No EPUB book available.');

    const voicesRes = await request.get(`${BACKEND_URL}/tts/voices`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const voices = await voicesRes.json();
    const defaultVoice = voices[0]?.id;

    const genRes = await request.post(`${BACKEND_URL}/books/${epubBook!.id}/generate/audio`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}`, 'Content-Type': 'application/json' },
      data: { voice_id: defaultVoice, chapter_indices: null },
      timeout: 180_000,
    });
    test.skip(genRes.status() !== 201, 'Failed to generate audio for download test.');
    const entries: any[] = await genRes.json();
    const chapterIndex = entries[0].chapter_index;

    const dlRes = await request.get(
      `${BACKEND_URL}/books/${epubBook!.id}/generate/audio/download/${chapterIndex}`,
      { headers: { Authorization: `Bearer ${authFixture.accessToken}` } },
    );
    expect(dlRes.status()).toBe(200);
    expect(dlRes.headers()['content-type']).toContain('audio/wav');
    const body = await dlRes.body();
    expect(body.length).toBeGreaterThan(1000);

    await request.delete(`${BACKEND_URL}/books/${epubBook!.id}/generate/audio/${entries[0].id}`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
  });

  test('DELETE /books/{book_id}/generate/audio/{audio_id} deletes generated entry', async ({ request }) => {
    test.skip(!epubBook, 'No EPUB book available.');

    const voicesRes = await request.get(`${BACKEND_URL}/tts/voices`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const voices = await voicesRes.json();
    const defaultVoice = voices[0]?.id;

    const genRes = await request.post(`${BACKEND_URL}/books/${epubBook!.id}/generate/audio`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}`, 'Content-Type': 'application/json' },
      data: { voice_id: defaultVoice, chapter_indices: null },
      timeout: 180_000,
    });
    test.skip(genRes.status() !== 201, 'Failed to generate audio for delete test.');
    const entries: any[] = await genRes.json();
    const audioId = entries[0].id;

    const delRes = await request.delete(
      `${BACKEND_URL}/books/${epubBook!.id}/generate/audio/${audioId}`,
      { headers: { Authorization: `Bearer ${authFixture.accessToken}` } },
    );
    expect(delRes.status()).toBe(204);

    const listRes = await request.get(`${BACKEND_URL}/books/${epubBook!.id}/generate/audio`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const listed: any[] = await listRes.json();
    expect(listed.find((e: any) => e.id === audioId)).toBeUndefined();
  });

  test('POST /books/{book_id}/generate/audio rejects non-EPUB books', async ({ request }) => {
    const booksRes = await request.get(`${BACKEND_URL}/books?limit=200`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}` },
    });
    const booksData = await booksRes.json();
    const books: Book[] = booksData.items || booksData;
    const audiobook = books.find((b) =>
      ['mp3', 'm4b', 'flac', 'ogg', 'aac', 'wma'].includes(b.file_format)
    );
    test.skip(!audiobook, 'No audiobook available for rejection test.');

    const res = await request.post(`${BACKEND_URL}/books/${audiobook!.id}/generate/audio`, {
      headers: { Authorization: `Bearer ${authFixture.accessToken}`, 'Content-Type': 'application/json' },
      data: { voice_id: 'default', chapter_indices: null },
    });
    expect(res.status()).toBe(400);
    const body = await res.json();
    expect(body.detail).toContain('Only EPUB books');
  });

});

test.describe('TTS Frontend', () => {

  test('EPUB reader shows TTS toolbar with voice selector and controls', async ({ page }) => {
    test.skip(!epubBook, 'No EPUB book available for frontend test.');

    await page.goto(`${FRONTEND_URL}/books/${epubBook!.id}/read`);
    await page.waitForTimeout(3000);

    await expect(page.getByTitle('Speak selection')).toBeVisible();
    await expect(page.getByTitle('Generate audio for book')).toBeVisible();
    await expectNoFrontendErrors(page);
  });

  test('Generate Audio dialog opens and displays voices', async ({ page }) => {
    test.skip(!epubBook, 'No EPUB book available for dialog test.');

    await page.goto(`${FRONTEND_URL}/books/${epubBook!.id}/read`);
    await page.waitForTimeout(3000);

    await page.getByTitle('Generate audio for book').click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByText('Generate Audio')).toBeVisible();
    await expect(page.getByText('Select a voice')).toBeVisible();

    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
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
