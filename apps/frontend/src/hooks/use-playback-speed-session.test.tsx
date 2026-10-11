import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePlayer } from './use-player';
import { usePlaybackSpeedSession } from './use-playback-speed-session';

const auth = vi.hoisted(() => ({
  session: { user: { id: 'alice' }, playbackSpeed: 1.5 },
  update: vi.fn(),
}));
vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: auth.session, status: 'authenticated', update: auth.update }),
}));
vi.mock('@/lib/logger', () => ({ logger: { player: { error: vi.fn() } } }));

beforeEach(() => {
  auth.session = { user: { id: 'alice' }, playbackSpeed: 1.5 };
  auth.update.mockReset().mockResolvedValue(auth.session);
  usePlayer.setState({ speed: 1, speedChangeVersion: 0 });
});

describe('session playback speed', () => {
  it('restores the user default without saving a spurious change', () => {
    const { rerender } = renderHook(() => usePlaybackSpeedSession());
    expect(usePlayer.getState().speed).toBe(1.5);
    expect(auth.update).not.toHaveBeenCalled();
    auth.session = { user: { id: 'bob' }, playbackSpeed: 1 };
    rerender();
    expect(usePlayer.getState().speed).toBe(1);
    expect(auth.update).not.toHaveBeenCalled();
  });

  it('saves explicit changes and preserves speed when the player resets', async () => {
    renderHook(() => usePlaybackSpeedSession());
    act(() => usePlayer.getState().setSpeed(2));
    await waitFor(() => expect(auth.update).toHaveBeenCalledWith({ playbackSpeed: 2 }));
    act(() => usePlayer.getState().reset());
    expect(usePlayer.getState().speed).toBe(2);
    expect(auth.update).toHaveBeenCalledTimes(1);
  });

  it('restores a different account even while a previous save is pending', () => {
    auth.update.mockImplementation(() => new Promise(() => {}));
    const { rerender } = renderHook(() => usePlaybackSpeedSession());
    act(() => usePlayer.getState().setSpeed(2));
    auth.session = { user: { id: 'bob' }, playbackSpeed: 1 };
    rerender();
    expect(usePlayer.getState().speed).toBe(1);
  });

  it('serializes rapid speed changes so the last choice wins', async () => {
    let resolve!: (value: unknown) => void;
    auth.update.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    renderHook(() => usePlaybackSpeedSession());
    act(() => {
      usePlayer.getState().setSpeed(1.75);
      usePlayer.getState().setSpeed(2);
    });
    await waitFor(() => expect(auth.update).toHaveBeenCalledTimes(1));
    act(() => resolve(auth.session));
    await waitFor(() => expect(auth.update).toHaveBeenCalledTimes(2));
    expect(auth.update.mock.calls[1][0]).toEqual({ playbackSpeed: 2 });
  });
});
