'use client';

import { useBooks, useBookStats } from '@/hooks/use-books';
import { BookGrid } from '@/components/books/book-grid';
import { useSession } from 'next-auth/react';
import { Library, BookOpen, CheckCircle2, Bookmark } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function DashboardPage() {
  const { data: session } = useSession();
  const { data: stats, isLoading: loadingStats, error: statsError } = useBookStats();
  const completionPercent = stats?.total ? Math.round(stats.completed / stats.total * 100) : 0;
  const statCards = [
    { label: 'Books in your library', value: stats?.total, icon: Library },
    { label: 'In progress', value: stats?.in_progress, icon: BookOpen },
    { label: 'Completed', value: stats?.completed, icon: CheckCircle2 },
    { label: 'Not started', value: stats?.not_started, icon: Bookmark },
  ];
  const { data: inProgressBooks, isLoading: loadingProgress, error: progressError } = useBooks({
    limit: 12,
    in_progress: true,
    sort: 'progress_updated_at',
    order: 'desc',
  });

  const { data: recentBooks, isLoading: loadingRecent, error: recentError } = useBooks({
    limit: 12,
    sort: 'created_at',
    order: 'desc',
  });

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Your dashboard</h1>
        <p className="mt-1 text-muted-foreground">
          Welcome back{session?.user?.name ? `, ${session.user.name}` : ''}. Pick up where you left off.
        </p>
      </div>

      <section aria-label="Your reading stats" className="space-y-4">
        {statsError ? (
          <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
            Unable to load your reading stats. Please try again later.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              {statCards.map(({ label, value, icon: Icon }) => (
                <Card key={label} className="p-4 sm:p-6">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <p className="text-sm text-muted-foreground">{label}</p>
                    <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-primary" />
                  </div>
                  {loadingStats || value === undefined ? <Skeleton className="h-9 w-16" /> : (
                    <p className="text-3xl font-semibold tabular-nums">{value.toLocaleString()}</p>
                  )}
                </Card>
              ))}
            </div>
            {stats && (
              <Card className="p-4 sm:p-6">
                <div className="mb-3 flex items-center justify-between gap-4 text-sm">
                  <p className="font-medium">Library completion</p>
                  <p className="text-muted-foreground">{stats.completed.toLocaleString()} of {stats.total.toLocaleString()} books · {completionPercent}%</p>
                </div>
                <div role="progressbar" aria-label="Library completion" aria-valuemin={0} aria-valuemax={100} aria-valuenow={completionPercent} className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${completionPercent}%` }} />
                </div>
                {stats.total === 0 && <p className="mt-3 text-sm text-muted-foreground">Add books to your library to start tracking your reading.</p>}
              </Card>
            )}
          </>
        )}
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold text-foreground">
          Continue Reading
        </h2>
        <BookGrid
          books={inProgressBooks?.items}
          isLoading={loadingProgress}
          error={progressError}
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
          error={recentError}
          emptyMessage="No books yet"
        />
      </section>
    </div>
  );
}
