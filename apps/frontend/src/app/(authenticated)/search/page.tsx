'use client';

import { useSearchParams, useRouter } from 'next/navigation';
import { useState, useEffect, Suspense } from 'react';
import { useSearch } from '@/hooks/use-search';
import { BookGrid } from '@/components/books/book-grid';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';

function SearchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const initialQuery = searchParams.get('q') || '';
  const [query, setQuery] = useState(initialQuery);
  const [typeFilter, setTypeFilter] = useState<string>('all');

  useEffect(() => {
    setQuery(initialQuery);
  }, [initialQuery]);

  const { data, isLoading, error } = useSearch({
    query,
    type: typeFilter !== 'all' ? typeFilter : undefined,
    limit: 50,
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) {
      router.push(routes.searchQuery(query.trim()));
    }
  };

  const filteredBooks = data?.items?.filter((book: any) => {
    if (typeFilter === 'all') return true;
    if (typeFilter === 'ebook') return !['mp3', 'm4b', 'aax', 'flac'].includes(book.format?.toLowerCase());
    if (typeFilter === 'audiobook') return ['mp3', 'm4b', 'aax', 'flac'].includes(book.format?.toLowerCase());
    return true;
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-foreground">Search</h1>
        <p className="mt-1 text-muted-foreground">
          Search across your entire library
        </p>
      </div>

      <form onSubmit={handleSearch}>
        <div className="relative">
          <Search className="absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by title, author, or series..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-14 pl-12 pr-12 text-lg"
            autoFocus
          />
          {query && (
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-3 top-1/2 -translate-y-1/2"
              onClick={() => setQuery('')}
            >
              <X className="h-5 w-5" />
            </Button>
          )}
        </div>
      </form>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Filter:</span>
        {['all', 'ebook', 'audiobook'].map((type) => (
          <Button
            key={type}
            variant={typeFilter === type ? 'secondary' : 'outline'}
            size="sm"
            onClick={() => setTypeFilter(type)}
          >
            {type === 'all' ? 'All' : type === 'ebook' ? 'Ebooks' : 'Audiobooks'}
          </Button>
        ))}
        {data && (
          <span className="ml-auto text-sm text-muted-foreground">
            {data.total} results
          </span>
        )}
      </div>

      {query && query.length < 2 ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Search className="h-12 w-12 text-muted-foreground/50" />
          <p className="mt-4 text-sm text-muted-foreground">
            Type at least 2 characters to search
          </p>
        </div>
      ) : (
        <BookGrid
          books={filteredBooks}
          isLoading={isLoading}
          error={error as Error | null}
          emptyMessage={query ? `No results found for "${query}"` : 'Start typing to search'}
        />
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-12">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      }
    >
      <SearchContent />
    </Suspense>
  );
}
