import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { clearProgress, enqueueProgress, replayProgressQueue } from './progress-queue';

const state = vi.hoisted(() => ({ user: 'alice', post: vi.fn().mockResolvedValue({}) }));
vi.mock('@/lib/api-client', () => ({
  api: { post: state.post },
  getAuthUserId: () => state.user,
  captureProgress: (data: any) => ({ ...data, expected_user_id: data.expected_user_id ?? state.user, captured_at: data.captured_at ?? Date.now() }),
}));

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  state.user = 'alice';
  state.post.mockClear();
});

async function entries(): Promise<any[]> {
  const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('todds-library', 2); request.onsuccess = () => resolve(request.result); });
  try {
    return await new Promise((resolve) => { const request = db.transaction('progress-queue-v2').objectStore('progress-queue-v2').getAll(); request.onsuccess = () => resolve(request.result); });
  } finally { db.close(); }
}

it('journals offline positions without Background Sync and replays only the signed-in user', async () => {
  await enqueueProgress({ bookId: 'book', position: 42, progress: 0.42, expected_user_id: 'alice', captured_at: 100 });
  await enqueueProgress({ bookId: 'book', position: 87, progress: 0.87, expected_user_id: 'bob', captured_at: 200 });
  expect(await entries()).toHaveLength(2);
  await replayProgressQueue();
  expect(state.post).toHaveBeenCalledTimes(1);
  expect(state.post).toHaveBeenCalledWith('/books/book/progress', expect.objectContaining({ position: 42, expected_user_id: 'alice', captured_at: 100 }));
  expect((await entries())[0].expected_user_id).toBe('bob');
});
it('retains newer queued snapshots when an older request is acknowledged', async () => {
  await enqueueProgress({ bookId: 'book', position: 42, progress: 0.42, captured_at: 100 });
  await enqueueProgress({ bookId: 'book', position: 87, progress: 0.87, captured_at: 200 });
  await clearProgress('book', 'alice', 100);
  expect((await entries())[0].position).toBe(87);
  await enqueueProgress({ bookId: 'book', position: 20, progress: 0.2, captured_at: 80 });
  expect((await entries())[0].position).toBe(87);
  await clearProgress('book', 'alice', 200);
  expect(await entries()).toHaveLength(0);
});
it('service worker sends only the account-bound snapshot and its original capture time', async () => {
  await enqueueProgress({ bookId: 'book', position: 42, progress: 0.42, expected_user_id: 'alice', captured_at: 100 });
  await enqueueProgress({ bookId: 'book', position: 87, progress: 0.87, expected_user_id: 'bob', captured_at: 200 });
  const fetch = vi.fn().mockImplementation(async (url) => url === '/api/auth/session'
    ? { ok: true, json: async () => ({ accessToken: `header.${btoa(JSON.stringify({ sub: 'alice' }))}.signature` }) }
    : { ok: true });
  const context: any = { indexedDB, fetch, atob, URL, self: { addEventListener: vi.fn(), location: { origin: 'https://library.test' } } };
  runInNewContext(readFileSync('public/sw.js', 'utf8'), context);
  await context.runSync();
  expect(fetch).toHaveBeenCalledTimes(2);
  const sent = JSON.parse(fetch.mock.calls[1][1].body);
  expect(sent.expected_user_id).toBe('alice');
  expect(sent.captured_at).toBe(100);
  expect((await entries())[0].expected_user_id).toBe('bob');
});
