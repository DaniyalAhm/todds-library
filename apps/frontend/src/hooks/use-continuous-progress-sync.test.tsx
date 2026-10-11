import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useContinuousProgressSync } from './use-continuous-progress-sync';

vi.mock('@/lib/api-client', () => ({
  api: { post: vi.fn().mockResolvedValue({}) },
}));

vi.mock('@/lib/progress-queue', () => ({
  enqueueProgress: vi.fn().mockResolvedValue(true),
}));

import { api } from '@/lib/api-client';

describe('useContinuousProgressSync', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', writable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('POSTs snapshot every 500ms when enabled', async () => {
    const getSnapshot = vi.fn(() => ({
      bookId: 'book-1',
      position: 42,
      progress: 0.5,
      location: 'cfi-123',
    }));

    renderHook(() => useContinuousProgressSync(true, getSnapshot, 500));

    // initial 500ms delay + interval
    await vi.advanceTimersByTimeAsync(500);
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/books/book-1/progress', {
      position: 42,
      progress: 0.5,
      location: 'cfi-123',
    });

    // Change position to simulate playback advancing
    getSnapshot.mockReturnValue({ bookId: 'book-1', position: 43, progress: 0.51, location: 'cfi-123' });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.post).toHaveBeenCalledTimes(2);

    // Deduplicates unchanged position
    await vi.advanceTimersByTimeAsync(500);
    expect(api.post).toHaveBeenCalledTimes(2);
  });

  it('does not POST when disabled', async () => {
    const getSnapshot = vi.fn(() => ({ bookId: 'book-1', position: 1, progress: 0.1 }));
    renderHook(() => useContinuousProgressSync(false, getSnapshot, 500));
    await vi.advanceTimersByTimeAsync(1500);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('pauses when document is hidden', async () => {
    const getSnapshot = vi.fn(() => ({ bookId: 'book-1', position: 10, progress: 0.2 }));
    renderHook(() => useContinuousProgressSync(true, getSnapshot, 500));
    await vi.advanceTimersByTimeAsync(500);
    expect(api.post).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', writable: true });
    getSnapshot.mockReturnValue({ bookId: 'book-1', position: 11, progress: 0.21 });
    await vi.advanceTimersByTimeAsync(1000);
    // hidden → no additional posts
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('handles null snapshot gracefully', async () => {
    const getSnapshot = vi.fn(() => null);
    renderHook(() => useContinuousProgressSync(true, getSnapshot, 500));
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.post).not.toHaveBeenCalled();
  });
});
