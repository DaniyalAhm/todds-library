'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useApplyBookMetadata, useLookupBookMetadata } from '@/hooks/use-books';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Search, RefreshCw, Check, ExternalLink } from 'lucide-react';
import { toast } from '@/components/ui/toast';
import { routes } from '@/lib/routes';

interface BookMetadataSearchProps {
  bookId: string;
  title?: string | null;
  author?: string | null;
  isbn?: string | null;
  asin?: string | null;
}

/**
 * Admin-only metadata provider search for a single book.
 * Render behind a `user?.isAdmin` gate — the backing endpoints
 * (`/metadata/lookup`, `/metadata/apply`) are admin-only server-side too.
 */
export function BookMetadataSearch({ bookId, title, author, isbn, asin }: BookMetadataSearchProps) {
  const [open, setOpen] = useState(false);
  const lookup = useLookupBookMetadata(bookId);
  const apply = useApplyBookMetadata(bookId);
  const candidates = lookup.data?.results || [];

  const handleSearch = (refresh: boolean) => {
    setOpen(true);
    lookup.mutate(
      { title: title || undefined, author: author || undefined, isbn: isbn || undefined, asin: asin || undefined, refresh },
      {
        onSuccess: (res) => {
          if (!res.results || res.results.length === 0) {
            toast({ title: 'No metadata found', description: 'Providers returned no matches for this book.', variant: 'default' });
          }
        },
        onError: (e: any) => {
          const msg = e?.response?.data?.detail || e?.message || 'Metadata lookup failed.';
          toast({ title: 'Metadata search failed', description: msg, variant: 'destructive' });
        },
      }
    );
  };

  const handleApply = (candidate: any) => {
    apply.mutate(candidate, {
      onSuccess: () => {
        toast({ title: 'Metadata applied', description: candidate.title || 'Book metadata updated.', variant: 'success' });
        setOpen(false);
        lookup.reset();
      },
      onError: (e: any) => {
        const msg = e?.response?.data?.detail || e?.message || 'Failed to apply metadata.';
        toast({ title: 'Apply failed', description: msg, variant: 'destructive' });
      },
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={() => handleSearch(false)} disabled={lookup.isPending}>
          <Search className="mr-2 h-4 w-4" />
          {lookup.isPending ? 'Searching...' : 'Search Metadata'}
        </Button>
        <Button variant="ghost" onClick={() => handleSearch(true)} disabled={lookup.isPending} title="Query providers fresh instead of using cached results">
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh Providers
        </Button>
        <Button variant="ghost" asChild>
          <Link href={routes.adminMetadata}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Full Metadata Editor
          </Link>
        </Button>
      </div>

      {open && (
        <Card>
          <CardContent className="space-y-3 pt-4">
            {lookup.isPending && (
              <p className="text-sm text-muted-foreground">Searching metadata providers...</p>
            )}
            {lookup.isError && (
              <p className="text-sm text-destructive">Metadata lookup failed.</p>
            )}
            {!lookup.isPending && !lookup.isError && candidates.length === 0 && (
              <p className="text-sm text-muted-foreground">No provider matches. Try Refresh Providers or the full editor.</p>
            )}
            {candidates.map((candidate, index) => (
              <div key={`${candidate.source || 'provider'}-${index}`} className="rounded-md border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">{candidate.title || 'Untitled'}</p>
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
                    onClick={() => handleApply(candidate)}
                    disabled={apply.isPending}
                  >
                    <Check className="mr-2 h-4 w-4" />
                    Apply
                  </Button>
                </div>
              </div>
            ))}
            {candidates.length > 0 && (
              <Button variant="ghost" size="sm" onClick={() => { setOpen(false); lookup.reset(); }}>
                Dismiss
              </Button>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
