'use client';

import { useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { useBookProgress, useSaveBookReview } from '@/hooks/use-books';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

export function BookReview({ bookId }: { bookId: string }) {
  const { data: progress } = useBookProgress(bookId);
  const save = useSaveBookReview(bookId);
  const [rating, setRating] = useState(0);
  const [text, setText] = useState('');
  const completed = progress?.completed || (progress?.progress ?? 0) >= 1;

  useEffect(() => {
    setRating(progress?.rating ?? 0);
    setText(progress?.review_text ?? '');
  }, [bookId, progress?.rating, progress?.review_text]);

  return (
    <section id="review" className="scroll-mt-6 space-y-3 rounded-lg border border-border bg-card p-4">
      <h2 className="text-lg font-semibold">Your review</h2>
      {!completed ? (
        <p className="text-sm text-muted-foreground">Complete this book to leave a review.</p>
      ) : (
        <form className="space-y-3" onSubmit={(event) => {
          event.preventDefault();
          if (!rating || save.isPending) return;
          save.mutate({ rating, review_text: text }, {
            onSuccess: () => toast({ title: 'Review saved', variant: 'success' }),
            onError: (error) => toast({ title: 'Could not save review', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' }),
          });
        }}>
          <fieldset disabled={save.isPending}>
            <legend className="mb-1 text-sm font-medium">Rating</legend>
            <div className="flex gap-1">
              {[1, 2, 3, 4, 5].map((value) => (
                <button key={value} type="button" aria-label={`${value} ${value === 1 ? 'star' : 'stars'}`} aria-pressed={rating === value} onClick={() => setRating(value)} className="rounded p-1.5 text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
                  <Star className={`h-6 w-6 ${value <= rating ? 'fill-current' : ''}`} />
                </button>
              ))}
            </div>
          </fieldset>
          <label className="block space-y-1 text-sm font-medium">
            <span>Written review (optional)</span>
            <textarea value={text} onChange={(event) => setText(event.target.value)} maxLength={5000} rows={4} disabled={save.isPending} placeholder="What did you think of this book?" className="w-full rounded-md border border-input bg-background px-3 py-2 font-normal focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" />
          </label>
          <Button type="submit" disabled={!rating || save.isPending}>
            {save.isPending ? 'Saving...' : progress?.rating ? 'Update review' : 'Save review'}
          </Button>
        </form>
      )}
    </section>
  );
}
