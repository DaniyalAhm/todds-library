'use client';

import { BookCard } from './book-card';
import { Skeleton } from '@/components/ui/skeleton';
import { BookOpen } from 'lucide-react';

interface BookGridProps {
  books?: Array<{
    id: string;
    title: string;
    author?: string | null;
    cover?: string;
    format: string;
    progress?: number;
    series?: string | null;
    duration?: number | null;
  }>;
  isLoading?: boolean;
  error?: Error | null;
  emptyMessage?: string;
}

function BookCardSkeleton() {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <Skeleton className="aspect-[2/3] w-full" />
      <div className="p-3 space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}

export function BookGrid({
  books,
  isLoading,
  error,
  emptyMessage = 'No books found',
}: BookGridProps) {
  if (error) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-destructive/50 bg-destructive/5 p-12 text-center">
        <BookOpen className="h-12 w-12 text-destructive/50" />
        <h3 className="mt-4 text-lg font-semibold text-destructive">
          Error loading books
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="grid grid-cols-[repeat(auto-fill,minmax(8.25rem,1fr))] gap-3 sm:gap-4">
        {Array.from({ length: 12 }).map((_, i) => (
          <BookCardSkeleton key={i} />
        ))}
      </div>
    );
  }

  if (!books || books.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card p-6 text-center sm:p-12">
        <BookOpen className="h-12 w-12 text-muted-foreground/50" />
        <h3 className="mt-4 text-lg font-semibold text-card-foreground">
          {emptyMessage}
        </h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Try adjusting your filters or add new books to your library.
        </p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(8.25rem,1fr))] gap-3 sm:gap-4">
      {books.map((book) => (
        <BookCard key={book.id} book={book} />
      ))}
    </div>
  );
}
