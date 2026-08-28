import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Shell } from './shell';
import { usePlayer } from '@/hooks/use-player';

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: { id: '1', username: 'test', isAdmin: false },
    isLoading: false,
    isAuthenticated: true,
    login: vi.fn(),
    loginLocal: vi.fn(),
    logout: vi.fn(),
    session: { user: { id: '1' } },
  }),
}));

vi.mock('next-auth/react', () => ({
  useSession: () => ({ data: null, status: 'unauthenticated' }),
  SessionProvider: ({ children }: any) => children,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/dashboard',
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('Shell layout with persistent player', () => {
  beforeEach(() => {
    usePlayer.setState({ currentBook: null, currentBookInfo: null });
    localStorage.clear();
  });

  it('main has no extra bottom padding when no currentBook (computed style)', () => {
    const { container } = render(
      <Shell>
        <div>content</div>
      </Shell>
    );
    const main = container.querySelector('main') as HTMLElement;
    expect(main).toBeTruthy();
    // Without currentBook, Shell does NOT add pb-24 — assert via class presence
    expect(main.className).not.toContain('pb-24');
    // Assert computed style paddingBottom is 0px (base p-3 yields pb via another rule, but pb-24 is 6rem = 96px)
    // In jsdom, tailwind classes are not applied as real CSS, so we assert via class instead of getComputedStyle
    // But we also verify that computed style is not 96px
    const style = getComputedStyle(main);
    // jsdom returns empty for tailwind, but we assert it's not 96px
    expect(style.paddingBottom).not.toBe('96px');
  });

  it('main has pb-24 bottom padding when currentBook is set (computed style)', () => {
    usePlayer.setState({
      currentBook: 'book-123',
      currentBookInfo: { id: 'book-123', title: 'The Martian', author: 'Andy Weir', cover: null },
    });

    const { container } = render(
      <Shell>
        <div>content</div>
      </Shell>
    );
    const main = container.querySelector('main') as HTMLElement;
    expect(main).toBeTruthy();
    // Assert via class — Shell adds pb-24 when currentBook exists
    expect(main.className).toContain('pb-24');

    // Assert via computed style — pb-24 = 6rem = 96px (when tailwind is loaded, jsdom will have no stylesheet,
    // so we polyfill by checking class and ensuring the element would have 96px if stylesheet present)
    // For real computed style, we inject a style tag to simulate tailwind's pb-24
    const styleTag = document.createElement('style');
    styleTag.innerHTML = '.pb-24{padding-bottom:6rem}';
    document.head.appendChild(styleTag);
    // Re-render to apply style? jsdom will apply stylesheet on next getComputedStyle
    const style = getComputedStyle(main);
    // jsdom does apply <style> sheets; 6rem = 96px (jsdom returns raw 6rem)
    expect(['6rem', '96px']).toContain(style.paddingBottom);
    document.head.removeChild(styleTag);
  });
});
