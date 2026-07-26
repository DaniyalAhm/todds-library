'use client';

import { useParams, useRouter } from 'next/navigation';
import { useBook } from '@/hooks/use-books';
import { EpubReader } from '@/components/reader/epub-reader';
import { PdfReader } from '@/components/reader/pdf-reader';
import { Button } from '@/components/ui/button';
import { ArrowLeft } from 'lucide-react';

export default function ReadPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { data: book, isLoading } = useBook(id);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex h-screen flex-col items-center justify-center bg-background">
        <p className="text-muted-foreground">Book not found</p>
        <Button variant="link" onClick={() => router.back()}>
          Go back
        </Button>
      </div>
    );
  }

  const isPdf = (book.ebook_format || book.format)?.toLowerCase() === 'pdf';

  if (!book.has_ebook && book.has_audiobook) {
    router.replace(`/books/${id}/listen`);
    return null;
  }

  return (
    <div className="flex h-screen flex-col bg-background">
      <div className="flex items-center gap-3 border-b border-border bg-card px-3 py-2 sm:gap-4 sm:px-4">
        <Button variant="ghost" size="icon" onClick={() => router.back()}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium text-foreground">{book.title}</h1>
          {book.author && (
            <p className="truncate text-xs text-muted-foreground">{book.author}</p>
          )}
        </div>
      </div>
      <div className="flex-1 overflow-hidden">
        {isPdf ? <PdfReader bookId={id} /> : <EpubReader bookId={id} />}
      </div>
    </div>
  );
}
