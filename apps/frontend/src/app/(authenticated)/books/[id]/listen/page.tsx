'use client';

import dynamic from 'next/dynamic';
import { useParams, useRouter } from 'next/navigation';
import { useBook } from '@/hooks/use-books';
import { MarkBookComplete } from '@/components/books/mark-book-complete';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';
import { routes } from '@/lib/routes';

const AudiobookPlayer = dynamic(
  () => import('@/components/player/audiobook-player').then((m) => m.AudiobookPlayer),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    ),
  }
);

export default function ListenPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { data: book, isLoading } = useBook(id);

  if (isLoading) {
    return (
      <div className="flex h-dvh items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center bg-background">
        <p className="text-muted-foreground">Book not found</p>
        <Button variant="link" onClick={() => router.back()}>
          Go back
        </Button>
      </div>
    );
  }

  if (!book.has_audiobook && book.has_ebook) {
    router.replace(routes.bookRead(id));
    return null;
  }

  return (
    <div className="flex h-dvh flex-col bg-background">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-card px-3 py-2 sm:gap-4 sm:px-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium text-foreground">{book.title}</h1>
          {book.author && (
            <p className="truncate text-xs text-muted-foreground">{book.author}</p>
          )}
        </div>
        <MarkBookComplete bookId={id} watchProgress />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        <AudiobookPlayer bookId={id} />
      </div>
    </div>
  );
}
