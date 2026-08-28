import '@testing-library/jest-dom/vitest';

// Mock navigator.mediaSession for jsdom
if (typeof navigator !== 'undefined' && !('mediaSession' in navigator)) {
  (navigator as any).mediaSession = {
    metadata: null,
    playbackState: 'none',
    setActionHandler: () => {},
    setPositionState: () => {},
  };
}

// Mock window.matchMedia
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  }),
});

// Polyfill ResizeObserver for Radix Slider
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = ResizeObserverMock as any;
}
if (typeof window.ResizeObserver === 'undefined') {
  (window as any).ResizeObserver = ResizeObserverMock;
}
