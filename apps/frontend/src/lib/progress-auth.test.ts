import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, captureProgress, getAuthUserId, postProgressWithKeepalive, setAuthSession } from './api-client';

const token = (user: string) => `header.${btoa(JSON.stringify({ sub: user }))}.signature`;
beforeEach(() => {
  setAuthSession(token('alice'), 'session-alice');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
});
afterEach(() => { vi.unstubAllGlobals(); });

it('binds snapshots to the authenticated user and preserves the original capture time', () => {
  const snapshot = captureProgress({ position: 42, progress: 0.42 });
  expect(snapshot.expected_user_id).toBe('alice');
  expect(captureProgress(snapshot).captured_at).toBe(snapshot.captured_at);
  expect(captureProgress({ position: 43 }).captured_at).toBeGreaterThan(snapshot.captured_at);
});
it('rejects a queued snapshot after the active account changes', async () => {
  const snapshot = captureProgress({ position: 42, progress: 0.42 });
  setAuthSession(token('bob'), 'session-bob');
  expect(getAuthUserId()).toBe('bob');
  await expect(api.post('/books/book/progress', snapshot)).rejects.toThrow('different user');
  postProgressWithKeepalive('book', snapshot);
  expect(fetch).not.toHaveBeenCalled();
});
it('includes user identity and capture time on ordinary progress saves', async () => {
  await api.post('/books/book/progress', { position: 42, progress: 0.42 });
  const data = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
  expect(data.expected_user_id).toBe('alice');
  expect(data.captured_at).toEqual(expect.any(Number));
});
