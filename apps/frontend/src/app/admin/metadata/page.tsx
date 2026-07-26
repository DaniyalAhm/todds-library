'use client';

import { useState } from 'react';
import {
  useApplyBookMetadata,
  useBooks,
  useLookupBookMetadata,
  useRefreshBookMetadata,
  useUpdateBookMetadata,
} from '@/hooks/use-books';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Check, Edit3, Search, RefreshCw, BookOpen, Save } from 'lucide-react';

export default function MetadataAdminPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading } = useBooks({
    search: search || undefined,
    limit: 50,
    sort: 'updated_at',
  });

  const books = data?.items || [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Metadata Management</h1>
        <p className="mt-1 text-muted-foreground">
          Review and edit book metadata
        </p>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search books to edit metadata..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-10"
        />
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full rounded-lg" />
          ))}
        </div>
      ) : books.length > 0 ? (
        <div className="space-y-3">
          {books.map((book: any) => (
            <MetadataEditCard key={book.id} book={book} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card p-12 text-center">
          <BookOpen className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-semibold">No books found</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            Search for books to edit their metadata.
          </p>
        </div>
      )}
    </div>
  );
}

function MetadataEditCard({ book }: { book: any }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(book.title || '');
  const [author, setAuthor] = useState(book.author || '');
  const [description, setDescription] = useState(book.description || '');
  const [publisher, setPublisher] = useState(book.publisher || '');
  const [isbn, setIsbn] = useState(book.isbn || '');
  const [series, setSeries] = useState(book.series || '');
  const updateMetadata = useUpdateBookMetadata(book.id);
  const refreshMetadata = useRefreshBookMetadata(book.id);
  const lookupMetadata = useLookupBookMetadata(book.id);
  const applyMetadata = useApplyBookMetadata(book.id);

  const hasMissingFields = !book.author || !book.description || !book.publisher;
  const candidates = lookupMetadata.data?.results || [];

  const handleSave = async () => {
    await updateMetadata.mutateAsync({
      title,
      author: author || null,
      description: description || null,
      publisher: publisher || null,
      isbn: isbn || null,
      series: series || null,
    });
    setEditing(false);
  };

  return (
    <Card className={hasMissingFields ? 'border-yellow-500/50' : ''}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <BookOpen className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">{book.title}</CardTitle>
              <p className="text-sm text-muted-foreground">
                {book.author || 'Unknown Author'} &middot; {book.format?.toUpperCase()}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {hasMissingFields && (
              <Badge variant="warning">Incomplete</Badge>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => lookupMetadata.mutate({ title, author, isbn, asin: book.asin || undefined })}
              disabled={lookupMetadata.isPending}
              title="Load saved metadata"
            >
              <Search className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => lookupMetadata.mutate({ title, author, isbn, asin: book.asin || undefined, refresh: true })}
              disabled={lookupMetadata.isPending}
              title="Refresh metadata providers"
            >
              <RefreshCw className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refreshMetadata.mutate()}
              disabled={refreshMetadata.isPending}
              title="Auto-fill missing metadata"
            >
              Auto
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setEditing(!editing)}>
              {editing ? <Save className="h-4 w-4" /> : <Edit3 className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>
      {editing && (
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Title</label>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Author</label>
              <Input value={author} onChange={(e) => setAuthor(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Series</label>
              <Input value={series} onChange={(e) => setSeries(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Publisher</label>
              <Input value={publisher} onChange={(e) => setPublisher(e.target.value)} />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">ISBN</label>
              <Input value={isbn} onChange={(e) => setIsbn(e.target.value)} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                rows={3}
              />
            </div>
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={updateMetadata.isPending}>
              Save Changes
            </Button>
          </div>
        </CardContent>
      )}
      {(lookupMetadata.isPending || refreshMetadata.isPending || candidates.length > 0 || lookupMetadata.error) && (
        <CardContent className="space-y-3 border-t border-border pt-4">
          {refreshMetadata.isPending && (
            <p className="text-sm text-muted-foreground">Refreshing metadata...</p>
          )}
          {lookupMetadata.isPending && (
            <p className="text-sm text-muted-foreground">Loading saved metadata...</p>
          )}
          {lookupMetadata.error && (
            <p className="text-sm text-destructive">Metadata lookup failed.</p>
          )}
          {candidates.map((candidate, index) => (
            <div key={`${candidate.source || 'provider'}-${index}`} className="rounded-md border border-border p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium text-sm">{candidate.title || 'Untitled'}</p>
                    {candidate.source && <Badge variant="outline">{candidate.source}</Badge>}
                    {candidate.cached && <Badge variant="secondary">Saved</Badge>}
                    {candidate.has_cover && <Badge variant="secondary">Cover</Badge>}
                  </div>
                  {candidate.author && <p className="text-xs text-muted-foreground">{candidate.author}</p>}
                  {candidate.publisher && (
                    <p className="text-xs text-muted-foreground">
                      {candidate.publisher}
                      {candidate.published_date ? ` · ${candidate.published_date}` : ''}
                    </p>
                  )}
                  {candidate.description && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{candidate.description}</p>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => applyMetadata.mutate(candidate)}
                  disabled={applyMetadata.isPending}
                >
                  <Check className="mr-2 h-4 w-4" />
                  Apply
                </Button>
              </div>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
