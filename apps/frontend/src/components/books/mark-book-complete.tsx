'use client';

import Link from 'next/link';
import { routes } from '@/lib/routes';
import { Check } from 'lucide-react';
import { useBookProgress, useCompleteBook } from '@/hooks/use-books';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';

export function MarkBookComplete({ bookId, watchProgress = false }: { bookId: string; watchProgress?: boolean }) {
  const { data: progress } = useBookProgress(bookId, watchProgress ? 3000 : false);
  const complete = useCompleteBook(bookId);
  const completed = progress?.completed || (progress?.progress ?? 0) >= 1;
  const eligible = (progress?.progress ?? 0) >= 0.85;

  if (completed) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1.5 px-2 text-sm font-medium text-green-600"><Check className="h-4 w-4" />Completed</span>
        <Link href={`${routes.book(bookId)}#review`} className="text-sm text-primary underline">Review</Link>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!eligible || complete.isPending}
      title={eligible ? 'Mark this book complete' : 'Read or listen to at least 85% to mark complete'}
      onClick={() => complete.mutate(undefined, {
        onSuccess: () => toast({ title: 'Book marked complete', variant: 'success' }),
        onError: (error) => toast({ title: 'Could not mark book complete', description: error instanceof Error ? error.message : 'Please try again.', variant: 'destructive' }),
      })}
    >
      <Check className="mr-1.5 h-4 w-4" />
      {complete.isPending ? 'Saving...' : 'Mark complete'}
    </Button>
  );
}
