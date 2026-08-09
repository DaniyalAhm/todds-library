'use client';

import { useParams, useRouter } from 'next/navigation';
import { useSession } from 'next-auth/react';
import { useAuth } from '@/hooks/use-auth';
import { useBook, useBookProgress, useBookmarks, useDeleteBookmark, useRefreshBookMetadata, useGenerateBookSubtitles } from '@/hooks/use-books';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast';
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
  RefreshCw,
  User,
} from 'lucide-react';
import { formatDuration, formatDate, formatFileSize, getProgressPercent } from '@/lib/utils';
import { routes } from '@/lib/routes';

export default function BookDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const { user } = useAuth();
  const { data: session } = useSession();
  const { data: book, isLoading } = useBook(id);
  const { data: progress } = useBookProgress(id);
  const { data: bookmarks } = useBookmarks(id);
  const deleteBookmark = useDeleteBookmark(id);
  const refreshMetadata = useRefreshBookMetadata(id);
  const generateBookSubtitles = useGenerateBookSubtitles(id);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex gap-8">
          <Skeleton className="h-96 w-72 shrink-0 rounded-lg" />
          <div className="flex-1 space-y-4">
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-24 w-full" />
          </div>
        </div>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <BookOpen className="h-12 w-12 text-muted-foreground/50" />
        <h2 className="mt-4 text-xl font-semibold">Book not found</h2>
      </div>
    );
  }

  const isMixedMedia = book.has_ebook && book.has_audiobook;
  const isAudiobook = book.has_audiobook && !book.has_ebook;
  const progressPercent = progress ? getProgressPercent(progress.progress, 1) : 0;
  const formatLabels: Record<string, string> = {
    epub: 'EPUB', pdf: 'PDF', mobi: 'MOBI',
    mp3: 'MP3 Audiobook', m4b: 'M4B Audiobook',
    cbz: 'CBZ Comic', cbr: 'CBR Comic',
  };

  const handleDownload = async () => {
    if (!book.download_url) return;
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
    link.download = book.file_path?.split('/').pop() || `${book.title}.${book.format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-8 md:flex-row">
        <div className="shrink-0">
          <div className="relative aspect-[2/3] w-48 overflow-hidden rounded-lg bg-muted sm:w-56 md:w-72">
            {book.cover ? (
              <img
                src={book.cover}
                alt={book.title}
                className="h-full w-full object-cover"
              />
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

        <div className="flex-1 space-y-4">
          <div>
            <div className="flex items-start gap-2">
              <h1 className="text-3xl font-bold text-foreground">{book.title}</h1>
              <Badge variant="outline" className="mt-1.5">
                {isMixedMedia
                  ? 'Ebook + Audiobook'
                  : formatLabels[book.format?.toLowerCase()] || book.format?.toUpperCase()}
              </Badge>
            </div>
            {book.author && (
              <p className="mt-2 text-lg text-muted-foreground">{book.author}</p>
            )}
            {book.series && (
              <p className="text-sm text-muted-foreground/70">{book.series}</p>
            )}
          </div>

          {progress && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium">{progressPercent}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {book.has_ebook && (
              <Button onClick={() => router.push(routes.bookRead(id))}>
                <BookOpen className="mr-2 h-4 w-4" />
                {progress && progress.progress > 0 ? 'Continue Reading' : 'Read Online'}
              </Button>
            )}
            {book.has_audiobook && (
              <Button onClick={() => router.push(routes.bookListen(id))}>
                <Headphones className="mr-2 h-4 w-4" />
                {progress && progress.progress > 0 ? 'Continue Listening' : 'Listen'}
              </Button>
            )}
            {book.download_url && (
              <Button variant="outline" onClick={handleDownload}>
                <Download className="mr-2 h-4 w-4" />
                Download
              </Button>
            )}
            {user?.isAdmin && (
              <Button
                variant="ghost"
                onClick={() => refreshMetadata.mutate()}
                disabled={refreshMetadata.isPending}
              >
                <Edit3 className="mr-2 h-4 w-4" />
                Refresh Metadata
              </Button>
            )}
            {user?.isAdmin && book.has_audiobook && (
              <Button
                variant="ghost"
                onClick={() =>
                  generateBookSubtitles.mutate(undefined, {
                    onSuccess: (res) => {
                      const failed = (res.results || []).filter((r) => r.status === 'failed');
                      toast({
                        title: 'Subtitle regeneration started',
                        description: failed.length > 0
                          ? `${failed.length} chapter(s) could not be regenerated.`
                          : 'Subtitles are being regenerated for all chapters.',
                        variant: failed.length > 0 ? 'destructive' : 'success',
                      });
                    },
                    onError: (error) => {
                      const message =
                        typeof error === 'object' && error !== null && 'message' in error
                          ? String((error as { message?: unknown }).message)
                          : 'Subtitle regeneration failed.';
                      toast({
                        title: 'Subtitle regeneration failed',
                        description: message,
                        variant: 'destructive',
                      });
                    },
                  })
                }
                disabled={generateBookSubtitles.isPending}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                {generateBookSubtitles.isPending ? 'Regenerating...' : 'Regenerate Subtitles'}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {book.publisher && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                <span>{book.publisher}</span>
              </div>
            )}
            {book.isbn && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Hash className="h-4 w-4" />
                <span>ISBN: {book.isbn}</span>
              </div>
            )}
            {book.page_count && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                <span>{book.page_count} pages</span>
              </div>
            )}
            {book.duration && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span>{formatDuration(book.duration)}</span>
              </div>
            )}
            {book.file_size && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <FileText className="h-4 w-4" />
                <span>{formatFileSize(book.file_size)}</span>
              </div>
            )}
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Calendar className="h-4 w-4" />
              <span>{formatDate(book.created_at)}</span>
            </div>
          </div>
        </div>
      </div>

      <Tabs defaultValue="description">
        <TabsList>
          <TabsTrigger value="description">Description</TabsTrigger>
          <TabsTrigger value="bookmarks">
            Bookmarks ({bookmarks?.length || 0})
          </TabsTrigger>
        </TabsList>
        <TabsContent value="description" className="text-sm text-muted-foreground leading-relaxed">
          {book.description || 'No description available.'}
        </TabsContent>
        <TabsContent value="bookmarks">
          {bookmarks && bookmarks.length > 0 ? (
            <div className="space-y-2">
              {bookmarks.map((bm) => (
                <div
                  key={bm.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-card p-3"
                >
                  <div className="flex items-center gap-3">
                    <Bookmark className="h-4 w-4 text-primary" />
                    <div>
                      <p className="text-sm font-medium">Position {Math.round(bm.position)}</p>
                      {bm.note && (
                        <p className="text-xs text-muted-foreground">
                          {bm.note}
                        </p>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => deleteBookmark.mutate(bm.id)}
                  >
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
