'use client';

import { useBooks } from '@/hooks/use-books';
import { BookGrid } from '@/components/books/book-grid';

export default function DashboardPage() {
  const { data: inProgressBooks, isLoading: loadingProgress } = useBooks({
    limit: 12,
    sort: 'updated_at',
    order: 'desc',
  });

  const { data: recentBooks, isLoading: loadingRecent } = useBooks({
    limit: 12,
    sort: 'created_at',
    order: 'desc',
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Dashboard</h1>
        <p className="mt-1 text-muted-foreground">
          Welcome back to your library
        </p>
      </div>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-foreground">
          Continue Reading
        </h2>
        <BookGrid
          books={inProgressBooks?.items?.filter(
            (b: any) => b.progress && b.progress > 0 && b.progress < 1
          )}
          isLoading={loadingProgress}
          emptyMessage="No books in progress"
        />
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-foreground">
          Recently Added
        </h2>
        <BookGrid
          books={recentBooks?.items}
          isLoading={loadingRecent}
          emptyMessage="No books yet"
        />
      </section>
    </div>
  );
}
