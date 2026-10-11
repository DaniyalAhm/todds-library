'use client';

import { Star } from 'lucide-react';
import { useBookRatings } from '@/hooks/use-books';

export function BookRatings({ bookId }: { bookId: string }) {
  const { data, isLoading, isError } = useBookRatings(bookId);
  return (
    <section className="space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">Reader ratings</h2>
      {isLoading ? <p className="text-sm text-muted-foreground">Loading ratings...</p> : isError ? (
        <p className="text-sm text-muted-foreground">Ratings could not be loaded.</p>
      ) : !data?.rating_count ? (
        <p className="text-sm text-muted-foreground">No ratings yet.</p>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <Star className="h-5 w-5 fill-current text-primary" />
            <span className="font-semibold">{data.average_rating?.toFixed(1)} out of 5</span>
            <span className="text-sm text-muted-foreground">({data.rating_count} {data.rating_count === 1 ? 'rating' : 'ratings'})</span>
          </div>
          <div className="max-w-sm space-y-1">
            {[5, 4, 3, 2, 1].map((star) => {
              const count = data.distribution[String(star)] ?? 0;
              return (
                <div key={star} className="flex items-center gap-2 text-sm" aria-label={`${star} stars: ${count} ${count === 1 ? 'rating' : 'ratings'}`}>
                  <span className="w-12">{star} stars</span>
                  <div className="h-2 flex-1 overflow-hidden rounded bg-secondary"><div className="h-full bg-primary" style={{ width: `${count / data.rating_count * 100}%` }} /></div>
                  <span className="w-6 text-right text-muted-foreground">{count}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}
