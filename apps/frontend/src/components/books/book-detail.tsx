'use client';

import { useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useBook, useBookProgress, useBookmarks, useDeleteBookmark } from '@/hooks/use-books';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import {
  BookOpen,
  Headphones,
  Download,
  Edit3,
  Bookmark,
  Trash2,
  Clock,
  Calendar,
  FileText,
  Hash,
  User,
} from 'lucide-react';
import { formatDuration, formatDate, formatFileSize, getProgressPercent } from '@/lib/utils';

interface BookDetailProps {
  bookId: string;
}

export function BookDetail({ bookId }: BookDetailProps) {
  const router = useRouter();
  const { data: session } = useSession();
  const { data: book, isLoading } = useBook(bookId);
  const { data: progress } = useBookProgress(bookId);
  const { data: bookmarks } = useBookmarks(bookId);
  const deleteBookmark = useDeleteBookmark(bookId);

  if (isLoading) {
    return (
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <Skeleton className="aspect-[2/3] w-48 shrink-0 rounded-lg sm:w-56 md:w-72" />
        <div className="flex-1 space-y-4">
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-5 w-1/2" />
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      </div>
    );
  }

  if (!book) return null;

  const isMixedMedia = book.has_ebook && book.has_audiobook;
  const isAudiobook = book.has_audiobook && !book.has_ebook;
  const progressPercent = progress ? getProgressPercent(progress.progress, 1) : 0;
  const formatLabels: Record<string, string> = {
    epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI',
    mp3: 'MP3 Audiobook', m4b: 'M4B Audiobook',
    cbz: 'CBZ Comic', cbr: 'CBR Comic',
  };

  const handleDownload = async () => {
    const response = await fetch(book.download_url, {
      headers: session?.accessToken
        ? { Authorization: `Bearer ${session.accessToken}` }
        : undefined,
    });
    if (!response.ok) return;
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${book.title}.${book.format || 'bin'}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-6 md:flex-row md:gap-8">
        <div className="shrink-0 self-center md:self-start">
          <div className="relative aspect-[2/3] w-44 overflow-hidden rounded-lg bg-muted sm:w-56 md:w-72">
            {book.cover ? (
              <img src={book.cover} alt={book.title} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                {isAudiobook ? (
                  <Headphones className="h-16 w-16 text-muted-foreground/50" />
                ) : (
                  <BookOpen className="h-16 w-16 text-muted-foreground/50" />
                )}
              </div>
            )}
          </div>
        </div>

        <div className="min-w-0 flex-1 space-y-4">
          <div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start">
              <h1 className="break-words text-2xl font-bold text-foreground sm:text-3xl">{book.title}</h1>
              <Badge variant="outline" className="mt-1.5">
                {isMixedMedia
                  ? 'Ebook + Audiobook'
                  : formatLabels[book.format?.toLowerCase()] || book.format?.toUpperCase()}
              </Badge>
            </div>
            {book.author && <p className="mt-2 text-lg text-muted-foreground">{book.author}</p>}
            {book.series && <p className="text-sm text-muted-foreground/70">{book.series}</p>}
          </div>

          {progress && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium">{progressPercent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          <div className="grid gap-2 sm:flex sm:flex-wrap">
            {book.has_ebook && (
              <Button className="w-full sm:w-auto" onClick={() => router.push(`/books/${bookId}/read`)}>
                <BookOpen className="mr-2 h-4 w-4" />
                {progress && progress.progress > 0 ? 'Continue Reading' : 'Read Online'}
              </Button>
            )}
            {book.has_audiobook && (
              <Button className="w-full sm:w-auto" onClick={() => router.push(`/books/${bookId}/listen`)}>
                <Headphones className="mr-2 h-4 w-4" />
                {progress && progress.progress > 0 ? 'Continue Listening' : 'Listen'}
              </Button>
            )}
            {book.file_path && (
              <Button className="w-full sm:w-auto" variant="outline" onClick={handleDownload}>
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {book.publisher && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4 shrink-0" /><span className="min-w-0 break-words">{book.publisher}</span>
              </div>
            )}
            {book.isbn && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Hash className="h-4 w-4 shrink-0" /><span className="min-w-0 break-words">ISBN: {book.isbn}</span>
              </div>
            )}
            {book.page_count && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4 shrink-0" /><span>{book.page_count} pages</span>
              </div>
            )}
            {book.duration && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4 shrink-0" /><span>{formatDuration(book.duration)}</span>
              </div>
            )}
            {book.file_size && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4 shrink-0" /><span>{formatFileSize(book.file_size)}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4 shrink-0" /><span>{formatDate(book.created_at)}</span>
            </div>
          </div>
        </div>
      </div>

      <Tabs defaultValue="description">
        <TabsList className="w-full overflow-x-auto sm:w-auto">
          <TabsTrigger value="description">Description</TabsTrigger>
          <TabsTrigger value="bookmarks">Bookmarks ({bookmarks?.length || 0})</TabsTrigger>
        </TabsList>
        <TabsContent value="description" className="text-sm text-muted-foreground leading-relaxed">
          {book.description || 'No description available.'}
        </TabsContent>
        <TabsContent value="bookmarks">
          {bookmarks && bookmarks.length > 0 ? (
            <div className="space-y-2">
              {bookmarks.map((bm: any) => (
                <div key={bm.id} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <Bookmark className="h-4 w-4 text-primary" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Position {Math.round(bm.position)}</p>
                      {bm.note && <p className="text-xs text-muted-foreground">{bm.note}</p>}
                    </div>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => deleteBookmark.mutate(bm.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No bookmarks yet.</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
