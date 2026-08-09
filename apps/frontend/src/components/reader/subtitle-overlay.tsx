'use client';

import { cn } from '@/lib/utils';

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
  words?: SubtitleWord[];
}

interface SubtitleWord {
  start: number;
  end: number;
  text: string;
}

interface SubtitleOverlayProps {
  currentTime: number;
  cues: SubtitleCue[];
  mode?: 'panel' | 'overlay' | 'fullscreen';
  className?: string;
}

const WORD_HIGHLIGHT_GRACE_SECONDS = 0.12;
const FULLSCREEN_PAGE_LEAD_SECONDS = 1;
const FULLSCREEN_TARGET_WORDS = 120;
const FULLSCREEN_MAX_CUES = 18;
const FULLSCREEN_PARAGRAPH_WORDS = 60;
const FULLSCREEN_PARAGRAPH_GAP_SECONDS = 2.5;

export function SubtitleOverlay({
  currentTime,
  cues,
  mode = 'overlay',
  className,
}: SubtitleOverlayProps) {
  const activeCues = cues.filter(
    (c) =>
      currentTime >= c.start - WORD_HIGHLIGHT_GRACE_SECONDS &&
      currentTime <= c.end + WORD_HIGHLIGHT_GRACE_SECONDS
  );

  if (mode === 'fullscreen') {
    const fullscreenPageTime = currentTime + FULLSCREEN_PAGE_LEAD_SECONDS;
    const page = getFullscreenPage(cues, fullscreenPageTime);
    const pageCues = page?.cues ?? [];
    if (pageCues.length === 0) return null;
    const paragraphs = groupFullscreenParagraphs(pageCues);

    return (
      <div
        className={cn(
          'flex h-full w-full items-center justify-center px-5 py-10 sm:px-10 lg:px-16',
          className
        )}
      >
        <div
          key={page?.key}
          className="max-h-full w-full max-w-5xl animate-[subtitle-page-flip_260ms_ease-out] overflow-hidden break-words text-left text-xl font-medium leading-9 text-white/70 [overflow-wrap:anywhere] sm:text-2xl sm:leading-10 lg:text-3xl lg:leading-[3.4rem]"
        >
          {paragraphs.map((paragraph, paragraphIndex) => (
            <p key={paragraphIndex} className="mb-7 last:mb-0">
              {paragraph.map((cue, cueIndex) => (
                <span
                  key={`${cue.start}-${cueIndex}`}
                  data-fullscreen-cue-active={isCueActive(cue, fullscreenPageTime) ? 'true' : undefined}
                >
                  <SubtitleCueText
                    cue={cue}
                    currentTime={currentTime}
                    activeClassName="rounded bg-white px-1 text-black shadow-sm box-decoration-clone"
                    cueActiveClassName="text-white"
                  />
                  {cueIndex < paragraph.length - 1 ? ' ' : ''}
                </span>
              ))}
            </p>
          ))}
        </div>
      </div>
    );
  }

  if (activeCues.length === 0) return null;

  if (mode === 'panel') {
    return (
      <div
        className={cn(
          'rounded-md border border-border bg-card px-4 py-3 text-center shadow-sm',
          className
        )}
      >
        {activeCues.map((cue, idx) => (
          <SubtitleLine
            key={`${cue.start}-${idx}`}
            cue={cue}
            currentTime={currentTime}
            className="mx-auto max-w-3xl text-base font-medium leading-7 text-foreground sm:text-lg"
            activeClassName="rounded bg-primary text-primary-foreground"
          />
        ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'pointer-events-none absolute bottom-4 left-0 right-0 z-30 px-4 text-center',
        className
      )}
    >
      {activeCues.map((cue, idx) => (
        <SubtitleLine
          key={`${cue.start}-${idx}`}
          cue={cue}
          currentTime={currentTime}
          className="mx-auto mb-1 max-w-2xl rounded-md bg-black/75 px-4 py-2 text-sm leading-relaxed text-white shadow-lg sm:text-base"
          activeClassName="rounded bg-primary text-primary-foreground"
        />
      ))}
    </div>
  );
}

function SubtitleLine({
  cue,
  currentTime,
  className,
  activeClassName,
}: {
  cue: SubtitleCue;
  currentTime: number;
  className?: string;
  activeClassName?: string;
}) {
  return (
    <p className={className}>
      <SubtitleCueText
        cue={cue}
        currentTime={currentTime}
        activeClassName={activeClassName}
        cueActiveClassName={activeClassName}
      />
    </p>
  );
}

function SubtitleCueText({
  cue,
  currentTime,
  activeClassName,
  cueActiveClassName,
}: {
  cue: SubtitleCue;
  currentTime: number;
  activeClassName?: string;
  cueActiveClassName?: string;
}) {
  const words = cue.words?.filter((word) => word.text.trim());
  const isCueActive =
    currentTime >= cue.start - WORD_HIGHLIGHT_GRACE_SECONDS &&
    currentTime <= cue.end + WORD_HIGHLIGHT_GRACE_SECONDS;

  if (!words || words.length === 0) {
    return (
      <span className={cn(isCueActive && cueActiveClassName)} data-subtitle-cue-active={isCueActive ? 'true' : undefined}>
        {cue.text}
      </span>
    );
  }

  const activeWordIndex = isCueActive ? getActiveWordIndex(cue, words, currentTime) : -1;

  return (
    <>
      {words.map((word, idx) => {
        const isActive = idx === activeWordIndex;
        return (
          <span
            key={`${word.start}-${idx}`}
            className={cn('transition-colors px-0.5', isActive && activeClassName)}
            data-subtitle-word-active={isActive ? 'true' : undefined}
          >
            {word.text}
            {idx < words.length - 1 ? ' ' : ''}
          </span>
        );
      })}
    </>
  );
}

function getFullscreenPage(cues: SubtitleCue[], currentTime: number): { cues: SubtitleCue[]; key: string } | null {
  if (cues.length === 0) return null;

  const pages = getFullscreenPages(cues);
  if (pages.length === 0) return null;

  let pageIndex = pages.findIndex((page) =>
    page.some((cue) => isCueActive(cue, currentTime))
  );

  if (pageIndex < 0) {
    pageIndex = pages.findIndex((page) => page[page.length - 1]?.end >= currentTime);
    if (pageIndex < 0) pageIndex = pages.length - 1;
  }

  const pageCues = pages[pageIndex];
  const firstCue = pageCues[0];
  const lastCue = pageCues[pageCues.length - 1];

  return {
    cues: pageCues,
    key: `${pageIndex}-${firstCue.start}-${lastCue.end}`,
  };
}

function getFullscreenPages(cues: SubtitleCue[]): SubtitleCue[][] {
  const pages: SubtitleCue[][] = [];
  let current: SubtitleCue[] = [];
  let currentWords = 0;

  for (const cue of cues) {
    const cueWords = countCueWords([cue]);
    const shouldStartPage =
      current.length > 0 &&
      (currentWords + cueWords > FULLSCREEN_TARGET_WORDS || current.length >= FULLSCREEN_MAX_CUES);

    if (shouldStartPage) {
      pages.push(current);
      current = [];
      currentWords = 0;
    }

    current.push(cue);
    currentWords += cueWords;
  }

  if (current.length > 0) {
    pages.push(current);
  }

  return pages;
}

function isCueActive(cue: SubtitleCue, currentTime: number, startGraceSeconds = WORD_HIGHLIGHT_GRACE_SECONDS): boolean {
  return (
    currentTime >= cue.start - startGraceSeconds &&
    currentTime <= cue.end + WORD_HIGHLIGHT_GRACE_SECONDS
  );
}

function groupFullscreenParagraphs(cues: SubtitleCue[]): SubtitleCue[][] {
  const paragraphs: SubtitleCue[][] = [];
  let current: SubtitleCue[] = [];
  let currentWords = 0;

  for (const cue of cues) {
    const previous = current[current.length - 1];
    const hasParagraphGap = previous ? cue.start - previous.end > FULLSCREEN_PARAGRAPH_GAP_SECONDS : false;
    const shouldStartParagraph =
      current.length > 0 &&
      (hasParagraphGap || currentWords >= FULLSCREEN_PARAGRAPH_WORDS);

    if (shouldStartParagraph) {
      paragraphs.push(current);
      current = [];
      currentWords = 0;
    }

    current.push(cue);
    currentWords += countCueWords([cue]);
  }

  if (current.length > 0) {
    paragraphs.push(current);
  }

  return paragraphs;
}

function countCueWords(cues: SubtitleCue[]): number {
  return cues.reduce((total, cue) => {
    if (cue.words?.length) {
      return total + cue.words.filter((word) => word.text.trim()).length;
    }
    return total + cue.text.trim().split(/\s+/).filter(Boolean).length;
  }, 0);
}

function getActiveWordIndex(cue: SubtitleCue, words: SubtitleWord[], currentTime: number): number {
  const exactIndex = words.findIndex(
    (word) =>
      currentTime >= word.start - WORD_HIGHLIGHT_GRACE_SECONDS &&
      currentTime <= word.end + WORD_HIGHLIGHT_GRACE_SECONDS
  );
  if (exactIndex >= 0) return exactIndex;

  if (
    currentTime < cue.start - WORD_HIGHLIGHT_GRACE_SECONDS ||
    currentTime > cue.end + WORD_HIGHLIGHT_GRACE_SECONDS
  ) {
    return -1;
  }

  const previousIndex = findLastIndex(
    words,
    (word) => currentTime >= word.start - WORD_HIGHLIGHT_GRACE_SECONDS
  );
  if (previousIndex >= 0) return previousIndex;

  return 0;
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return index;
  }
  return -1;
}

export async function loadSubtitleFile(
  bookId: string,
  chapterId: string,
  format: 'json' | 'srt' | 'vtt' = 'json'
): Promise<SubtitleCue[]> {
  if (format === 'json') {
    const jsonCues = await loadJsonSubtitleFile(bookId, chapterId);
    if (jsonCues.length > 0) {
      return jsonCues;
    }
    return loadSubtitleFile(bookId, chapterId, 'srt');
  }

  try {
    const { getApiUrl, getAuthHeaders } = await import('@/lib/api-client');
    const response = await fetch(
      getApiUrl(`/books/${bookId}/chapters/${chapterId}/subtitles?format=${format}`),
      {
        headers: {
          Accept: 'text/plain',
          ...getAuthHeaders(),
        },
      }
    );
    if (!response.ok) return [];
    const text = await response.text();
    return parseSubtitles(text, format);
  } catch {
    return [];
  }
}

async function loadJsonSubtitleFile(bookId: string, chapterId: string): Promise<SubtitleCue[]> {
  try {
    const { getApiUrl, getAuthHeaders } = await import('@/lib/api-client');
    const response = await fetch(
      getApiUrl(`/books/${bookId}/chapters/${chapterId}/subtitles?format=json`),
      {
        headers: {
          Accept: 'application/json',
          ...getAuthHeaders(),
        },
      }
    );
    if (!response.ok) return [];
    const data = await response.json();
    return normalizeJsonSubtitles(data);
  } catch {
    return [];
  }
}

function normalizeJsonSubtitles(data: unknown): SubtitleCue[] {
  const cues = Array.isArray(data)
    ? data
    : typeof data === 'object' && data !== null && 'cues' in data && Array.isArray(data.cues)
      ? data.cues
      : [];

  return cues
    .map((cue): SubtitleCue | null => {
      if (typeof cue !== 'object' || cue === null) return null;
      const candidate = cue as Partial<SubtitleCue>;
      if (
        typeof candidate.start !== 'number' ||
        typeof candidate.end !== 'number' ||
        typeof candidate.text !== 'string'
      ) {
        return null;
      }
      const words = Array.isArray(candidate.words)
        ? candidate.words.filter(isSubtitleWord)
        : undefined;
      return {
        start: candidate.start,
        end: candidate.end,
        text: candidate.text,
        words,
      };
    })
    .filter((cue): cue is SubtitleCue => cue !== null);
}

function isSubtitleWord(word: unknown): word is SubtitleWord {
  if (typeof word !== 'object' || word === null) return false;
  const candidate = word as Partial<SubtitleWord>;
  return (
    typeof candidate.start === 'number' &&
    typeof candidate.end === 'number' &&
    typeof candidate.text === 'string'
  );
}

function parseSubtitles(content: string, format: 'srt' | 'vtt'): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  const lines = content.split('\n');
  let currentCue: Partial<SubtitleCue> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (format === 'srt' && /^\d+$/.test(trimmed)) {
      currentCue = {};
      continue;
    }
    if (trimmed.includes('-->')) {
      const times = trimmed.split('-->');
      if (times.length === 2 && currentCue) {
        currentCue.start = parseTime(times[0].trim(), format);
        currentCue.end = parseTime(times[1].trim(), format);
      }
      continue;
    }
    if (currentCue && trimmed && !trimmed.startsWith('WEBVTT')) {
      currentCue.text = (currentCue.text || '') + (currentCue.text ? ' ' : '') + trimmed;
      continue;
    }
    if (currentCue && currentCue.start !== undefined && currentCue.text) {
      cues.push(currentCue as SubtitleCue);
      currentCue = null;
    }
  }
  if (currentCue && currentCue.start !== undefined && currentCue.text) {
    cues.push(currentCue as SubtitleCue);
  }
  return cues;
}

function parseTime(timeStr: string, format: 'srt' | 'vtt'): number {
  const separator = format === 'srt' ? ',' : '.';
  const parts = timeStr.replace(separator, '.').split(':');
  if (parts.length === 3) {
    const [h, m, s] = parts;
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  }
  return 0;
}

export type { SubtitleCue, SubtitleWord };
