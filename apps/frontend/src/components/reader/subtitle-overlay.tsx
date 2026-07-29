'use client';

import { cn } from '@/lib/utils';

interface SubtitleCue {
  start: number;
  end: number;
  text: string;
}

interface SubtitleOverlayProps {
  currentTime: number;
  cues: SubtitleCue[];
  className?: string;
}

export function SubtitleOverlay({ currentTime, cues, className }: SubtitleOverlayProps) {
  const activeCues = cues.filter((c) => currentTime >= c.start && currentTime <= c.end);

  if (activeCues.length === 0) return null;

  return (
    <div className={cn('pointer-events-none absolute bottom-4 left-0 right-0 z-30 px-4 text-center', className)}>
      {activeCues.map((cue, idx) => (
        <p
          key={idx}
          className="mx-auto mb-1 max-w-2xl rounded-lg bg-black/70 px-4 py-2 text-sm leading-relaxed text-white shadow-lg"
        >
          {cue.text}
        </p>
      ))}
    </div>
  );
}

export async function loadSubtitleFile(
  bookId: string,
  chapterId: string,
  format: 'srt' | 'vtt' = 'vtt'
): Promise<SubtitleCue[]> {
  try {
    const { getAuthHeaders } = await import('@/lib/api-client');
    const response = await fetch(
      `/api/books/${bookId}/chapters/${chapterId}/subtitles?format=${format}`,
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

export type { SubtitleCue };
