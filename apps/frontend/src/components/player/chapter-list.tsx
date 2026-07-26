'use client';

import { cn } from '@/lib/utils';
import { formatDurationDetailed } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';

interface Chapter {
  id: string;
  title: string;
  start: number;
  end: number;
}

interface ChapterListProps {
  chapters: Chapter[];
  currentChapterIndex: number;
  onSelectChapter: (index: number) => void;
  className?: string;
}

export function ChapterList({
  chapters,
  currentChapterIndex,
  onSelectChapter,
  className,
}: ChapterListProps) {
  if (!chapters || chapters.length === 0) {
    return (
      <div className={cn('p-4 text-sm text-muted-foreground', className)}>
        No chapters available
      </div>
    );
  }

  return (
    <div className={cn('', className)}>
      <h3 className="px-4 py-3 text-sm font-medium text-foreground border-b border-border">
        Chapters
      </h3>
      <ScrollArea className="h-full">
        <div className="p-2">
          {chapters.map((chapter, idx) => (
            <button
              key={chapter.id}
              onClick={() => onSelectChapter(idx)}
              className={cn(
                'flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors',
                idx === currentChapterIndex
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
              )}
            >
              <span className="line-clamp-1 flex-1">{chapter.title}</span>
              <span className="ml-2 shrink-0 text-xs tabular-nums text-muted-foreground">
                {formatDurationDetailed(chapter.end - chapter.start)}
              </span>
            </button>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
