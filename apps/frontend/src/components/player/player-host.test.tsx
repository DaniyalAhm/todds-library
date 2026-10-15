import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerHost } from './player-host';
import { useAudioPlayer } from './audio-player-context';
import { usePlayer } from '@/hooks/use-player';

const mocks = vi.hoisted(() => ({ getSnapshot: null as null | (() => any), mutate: vi.fn(), progressLoaded: true }));
const book = {
  id: 'book', title: 'Book', duration: 200, audio_track_count: 2,
  audio_download_url: 'http://localhost/audio', stream_url: '',
  chapters: [
    { id: 'second', index: 2, title: 'Second', start_position: 100, end_position: 200 },
    { id: 'first', index: 1, title: 'First', start_position: 0, end_position: 100 },
  ],
};
const progress = { position: 120 };
vi.mock('@/hooks/use-books', () => ({
  useBook: () => ({ data: book }),
  useBookProgress: () => ({ data: progress, isSuccess: mocks.progressLoaded }),
  useUpdateProgress: () => ({ mutate: mocks.mutate }),
}));
vi.mock('@/hooks/use-playback-speed-session', () => ({ usePlaybackSpeedSession: () => {} }));
vi.mock('@/hooks/use-media-session', () => ({ useMediaSession: () => {} }));
vi.mock('@/hooks/use-continuous-progress-sync', () => ({
  useContinuousProgressSync: (_enabled: boolean, getSnapshot: () => any) => { mocks.getSnapshot = getSnapshot; },
}));
vi.mock('@/lib/api-client', () => ({
  captureProgress: (snapshot: object) => snapshot,
  getAccessToken: () => null,
  postProgressWithKeepalive: vi.fn(),
  refreshAuthSession: vi.fn(),
}));
vi.mock('@/lib/progress-queue', () => ({ clearProgress: vi.fn(), enqueueProgress: vi.fn() }));
function Controls() {
  const audio = useAudioPlayer();
  return <button onClick={() => audio.seek(30)}>Seek first track</button>;
}

describe('chapter progress', () => {
  beforeEach(() => {
    mocks.progressLoaded = true;
    usePlayer.getState().reset();
    usePlayer.getState().setCurrentBook('book');
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('saves when progress arrives after metadata for the already loaded track', () => {
    mocks.progressLoaded = false;
    const { container, rerender } = render(<PlayerHost />);
    const audio = container.querySelector('audio')!;
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
    Object.defineProperty(audio, 'duration', { configurable: true, value: 100 });
    fireEvent.loadedMetadata(audio);
    expect(mocks.getSnapshot!()).toBeNull();

    const originalPosition = progress.position;
    progress.position = 20;
    mocks.progressLoaded = true;
    try {
      rerender(<PlayerHost />);
      expect(audio.currentTime).toBe(20);
      expect(mocks.getSnapshot!()).toMatchObject({ position: 20, progress: 0.1 });
      audio.currentTime = 25;
      fireEvent.pause(audio);
      expect(mocks.mutate).toHaveBeenCalledWith(expect.objectContaining({ position: 25 }), expect.any(Object));
    } finally {
      progress.position = originalPosition;
    }
  });

  it('restores a chapter-local timestamp and saves a global position only after metadata loads', () => {
    const { container } = render(<PlayerHost><Controls /></PlayerHost>);
    const audio = container.querySelector('audio')!;
    Object.defineProperty(audio, 'readyState', { configurable: true, value: 1 });
    Object.defineProperty(audio, 'duration', { configurable: true, value: 100 });
    expect(usePlayer.getState().chapters.map((chapter) => chapter.id)).toEqual(['first', 'second']);
    expect(mocks.getSnapshot!()).toBeNull();
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(20);
    expect(mocks.getSnapshot!()).toMatchObject({ position: 120, progress: 0.6 });

    fireEvent.click(screen.getByText('Seek first track'));
    // The old track's currentTime must never be persisted under the new track.
    expect(mocks.getSnapshot!()).toBeNull();
    fireEvent.timeUpdate(audio);
    expect(usePlayer.getState().currentTime).toBe(30);
    fireEvent.loadedMetadata(audio);
    expect(audio.currentTime).toBe(30);
    expect(mocks.getSnapshot!()).toMatchObject({ position: 30, progress: 0.15 });
  });
});
