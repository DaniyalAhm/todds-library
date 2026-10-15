import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SubtitleOverlay, loadSubtitleFile } from './subtitle-overlay';

const cues = [
  { start: 0, end: 2, text: 'Hello world', words: [
    { start: 0, end: 1, text: 'Hello' },
    { start: 1, end: 2, text: 'world' },
  ] },
  { start: 2, end: 4, text: 'Next sentence' },
];

describe('subtitle read-along', () => {
  it('keeps the panel visible in timing gaps without highlighting unspoken words', () => {
    const spacedCues = [cues[0], { ...cues[1], start: 5, end: 7 }];
    const { container, rerender } = render(<SubtitleOverlay currentTime={1.5} cues={spacedCues} mode="panel" />);
    const panel = container.firstElementChild;
    rerender(<SubtitleOverlay currentTime={3} cues={spacedCues} mode="panel" />);
    expect(container.firstElementChild).toBe(panel);
    expect(container.textContent).toBe('Hello world');
    expect(container.querySelector('[data-subtitle-word-active="true"]')).toBeNull();
    rerender(<SubtitleOverlay currentTime={5} cues={spacedCues} mode="panel" />);
    expect(container.textContent).toBe('Next sentence');
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('Next');
    rerender(<SubtitleOverlay currentTime={-1} cues={spacedCues} mode="panel" />);
    expect(container.firstElementChild).toBe(panel);
    expect(container.textContent).toBe('');
  });

  it('switches cues and words once at their exact playback boundary', () => {
    const { container, rerender } = render(<SubtitleOverlay currentTime={1.99} cues={cues} mode="panel" />);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.textContent).toBe('Hello world');
    rerender(<SubtitleOverlay currentTime={2} cues={cues} mode="panel" />);
    expect(container.querySelectorAll('p')).toHaveLength(1);
    expect(container.textContent).toBe('Next sentence');
    rerender(<SubtitleOverlay currentTime={1} cues={cues} mode="panel" />);
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('world');
  });

  it.each(['panel', 'overlay', 'fullscreen'] as const)('highlights the spoken word in %s mode', (mode) => {
    const { container } = render(<SubtitleOverlay currentTime={1.5} cues={cues} mode={mode} />);
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('world');
  });

  it('advances approximate word highlighting for cue-only subtitles', () => {
    const { container, rerender } = render(<SubtitleOverlay currentTime={2.3} cues={cues} mode="panel" />);
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('Next');
    rerender(<SubtitleOverlay currentTime={3.5} cues={cues} mode="panel" />);
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('sentence');
  });

  it('keeps the current fullscreen page until its last spoken word ends', () => {
    const pageCues = Array.from({ length: 19 }, (_, index) => ({
      start: index * 2, end: index * 2 + 2, text: `word${index}`,
    }));
    const { container } = render(<SubtitleOverlay currentTime={35.5} cues={pageCues} mode="fullscreen" />);
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('word17');
  });

  it('switches fullscreen pages at the boundary and follows backward seeks', () => {
    const pageCues = Array.from({ length: 19 }, (_, index) => ({
      start: index * 2, end: index * 2 + 2, text: `word${index}`,
    }));
    const { container, rerender } = render(<SubtitleOverlay currentTime={35.99} cues={pageCues} mode="fullscreen" />);
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('word17');
    rerender(<SubtitleOverlay currentTime={36} cues={pageCues} mode="fullscreen" />);
    expect(container.textContent).toBe('word18');
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('word18');
    rerender(<SubtitleOverlay currentTime={1} cues={pageCues} mode="fullscreen" />);
    expect(container.querySelector('[data-subtitle-word-active="true"]')?.textContent?.trim()).toBe('word0');
  });
});

vi.mock('@/lib/api-client', () => ({
  getApiUrl: (path: string) => path,
  getAuthHeaders: () => ({}),
}));

describe('subtitle file timing', () => {
  it('keeps collapsed ASR paragraphs visible between cues', async () => {
    const broken = {
      start: 527.61, end: 529.01, text: 'One two three four five six',
      words: ['One', 'two', 'three', 'four', 'five', 'six'].map((text, index) => ({
        text, start: index === 0 ? 527.61 : 529.01, end: 529.01,
      })),
    };
    const valid = { start: 652.43, end: 660, text: 'Next sentence' };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ cues: [broken, valid] }),
    }));
    try {
      const loaded = await loadSubtitleFile('book', 'chapter');
      expect(loaded[0]).toMatchObject({ start: 527.61, end: 652.43, words: undefined });
      expect(loaded[1]).toEqual({ ...valid, words: undefined });
      const { container } = render(<SubtitleOverlay currentTime={540} cues={loaded} mode="panel" />);
      expect(container.textContent).toContain('One two three four five six');
      expect(container.querySelector('[data-subtitle-word-active="true"]')).not.toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
