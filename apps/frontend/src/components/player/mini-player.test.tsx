import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MiniPlayer } from './mini-player';
import { usePlayer } from '@/hooks/use-player';

// Mock next/link to avoid Next.js router context
vi.mock('next/link', () => ({
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

// Mock useAudioPlayer hook
vi.mock('./audio-player-context', () => ({
  useAudioPlayer: () => ({
    audioRef: { current: null },
    audioElement: null,
    audioSrc: '',
    loadError: '',
    trackIndex: 0,
    isMultiTrackDirect: false,
    prefersDirectPlayback: false,
    play: vi.fn(),
    pause: vi.fn(),
    toggle: vi.fn(),
    seek: vi.fn(),
    seekRelative: vi.fn(),
    nextChapter: vi.fn(),
    prevChapter: vi.fn(),
    selectChapter: vi.fn(),
    setTrackIndex: vi.fn(),
    clearError: vi.fn(),
    triedHls: false,
  }),
}));

describe('MiniPlayer', () => {
  beforeEach(() => {
    // Reset player state
    usePlayer.setState({
      currentBook: null,
      currentBookInfo: null,
      currentTime: 0,
      duration: 0,
      isPlaying: false,
    });
    localStorage.clear();
  });

  it('renders nothing when no currentBook', () => {
    const { container } = render(<MiniPlayer />);
    expect(container.firstChild).toBeNull();
  });

  it('renders title and cover when currentBook is set', () => {
    usePlayer.setState({
      currentBook: 'book-123',
      currentBookInfo: {
        id: 'book-123',
        title: 'The Martian',
        author: 'Andy Weir',
        cover: 'http://example.com/cover.jpg',
      },
      currentTime: 42,
      duration: 3600,
    });

    render(<MiniPlayer />);
    expect(screen.getByText('The Martian')).toBeInTheDocument();
    expect(screen.getByText('Andy Weir')).toBeInTheDocument();
    // Title + duration both contain time; check that at least one matches
    expect(screen.getAllByText(/0:42/).length).toBeGreaterThan(0);
  });

  it('asserts computed style of fixed player bar (network-only shell awareness)', () => {
    usePlayer.setState({
      currentBook: 'book-456',
      currentBookInfo: { id: 'book-456', title: 'Project Hail Mary', author: 'Andy Weir', cover: null },
      currentTime: 100,
      duration: 1000,
    });

    // Inject minimal CSS so jsdom getComputedStyle reflects tailwind's fixed + bottom-0
    const styleTag = document.createElement('style');
    styleTag.innerHTML = '.fixed{position:fixed}.bottom-0{bottom:0px}';
    document.head.appendChild(styleTag);

    const { container } = render(<MiniPlayer />);
    const bar = container.firstChild as HTMLElement;
    expect(bar).toBeTruthy();
    expect(bar.className).toContain('fixed');
    expect(bar.className).toContain('bottom-0');

    // Assert fixed positioning via computed style (vitest jsdom getComputedStyle)
    const style = getComputedStyle(bar);
    expect(style.position).toBe('fixed');
    expect(style.bottom).toBe('0px');
    // Progress bar height 0.5 via h-0.5 class - verify presence
    expect(bar.querySelector('.h-0\\.5')).toBeTruthy();

    document.head.removeChild(styleTag);
  });
});
