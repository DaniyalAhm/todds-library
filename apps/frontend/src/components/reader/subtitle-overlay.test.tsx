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
