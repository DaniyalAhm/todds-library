'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { BookOpen, Headphones } from 'lucide-react';
import { routes } from '@/lib/routes';

interface BookCardProps {
  book: {
    id: string;
    title: string;
    author?: string | null;
    cover?: string;
    format: string;
    has_ebook?: boolean;
    has_audiobook?: boolean;
    ebook_format?: string | null;
    audiobook_format?: string | null;
    progress?: number;
    series?: string | null;
    duration?: number | null;
  };
}

const formatLabels: Record<string, { label: string; color: string }> = {
  epub: { label: 'EPUB', color: 'bg-blue-500/20 text-blue-500' },
  pdf: { label: 'PDF', color: 'bg-red-500/20 text-red-500' },
  mobi: { label: 'MOBI', color: 'bg-purple-500/20 text-purple-500' },
  cbz: { label: 'CBZ', color: 'bg-orange-500/20 text-orange-500' },
  cbr: { label: 'CBR', color: 'bg-orange-500/20 text-orange-500' },
  mp3: { label: 'Audiobook', color: 'bg-green-500/20 text-green-500' },
  m4b: { label: 'Audiobook', color: 'bg-green-500/20 text-green-500' },
  aax: { label: 'Audiobook', color: 'bg-green-500/20 text-green-500' },
  flac: { label: 'Audiobook', color: 'bg-green-500/20 text-green-500' },
};

export function BookCard({ book }: BookCardProps) {
  const isMixedMedia = !!book.has_ebook && !!book.has_audiobook;
  const displayFormat = isMixedMedia ? 'mixed' : book.format?.toLowerCase();
  const formatInfo = isMixedMedia
    ? { label: 'Ebook + Audio', color: 'bg-emerald-500/20 text-emerald-500' }
    : formatLabels[displayFormat] || {
    label: displayFormat?.toUpperCase() || 'Unknown',
    color: 'bg-secondary text-secondary-foreground',
  };
  const isAudiobook = !!book.has_audiobook && !book.has_ebook;
  const progress = book.progress ?? 0;

  return (
    <Link href={routes.book(book.id)} className="group block">
      <div className="relative overflow-hidden rounded-lg border border-border bg-card transition-all hover:border-primary/50 hover:shadow-md">
        <div className="relative aspect-[2/3] overflow-hidden bg-muted">
          {book.cover ? (
            <img
              src={book.cover}
              alt={book.title}
              className="h-full w-full object-cover transition-transform group-hover:scale-105"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              {isAudiobook ? (
                <Headphones className="h-12 w-12 text-muted-foreground/50" />
              ) : isMixedMedia ? (
                <div className="flex items-center gap-2 text-muted-foreground/50">
                  <BookOpen className="h-10 w-10" />
                  <Headphones className="h-10 w-10" />
                </div>
              ) : (
                <BookOpen className="h-12 w-12 text-muted-foreground/50" />
              )}
            </div>
          )}

          <div className="absolute left-2 top-2">
            <Badge
              variant="outline"
              className={cn('max-w-[calc(100%-1rem)] truncate text-[0.68rem] font-medium sm:text-xs', formatInfo.color)}
            >
              {formatInfo.label}
            </Badge>
          </div>

          {progress > 0 && progress < 1 && (
            <div className="absolute bottom-0 left-0 right-0 h-1 bg-muted-foreground/20">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
          )}
        </div>

        <div className="p-2.5 sm:p-3">
          <h3 className="line-clamp-2 min-h-[2.5rem] text-sm font-medium leading-5 text-card-foreground">
            {book.title}
          </h3>
          {book.author && (
            <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
              {book.author}
            </p>
          )}
          {book.series && (
            <p className="mt-0.5 text-xs text-muted-foreground/70">
              {book.series}
            </p>
          )}
        </div>
      </div>
    </Link>
  );
}
