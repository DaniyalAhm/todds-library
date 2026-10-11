import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { BookReview } from './book-review';

const state = vi.hoisted(() => ({
  progress: { completed: true, progress: 0.85, rating: null as number | null, review_text: null as string | null },
  mutate: vi.fn(),
}));
vi.mock('@/hooks/use-books', () => ({
  useBookProgress: () => ({ data: state.progress }),
  useSaveBookReview: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));
beforeEach(() => {
  state.progress = { completed: true, progress: 0.85, rating: null, review_text: null };
  state.mutate.mockClear();
});

it('locks reviews until completed', () => {
  state.progress.completed = false;
  render(<BookReview bookId="book" />);
  expect(screen.getByText('Complete this book to leave a review.')).toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
it('requires a rating and saves selected stars with written feedback', () => {
  render(<BookReview bookId="book" />);
  expect(screen.getByRole('button', { name: 'Save review' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: '4 stars' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Loved this book' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save review' }));
  expect(state.mutate).toHaveBeenCalledWith({ rating: 4, review_text: 'Loved this book' }, expect.any(Object));
});
it('loads the existing review for editing', () => {
  state.progress.rating = 5;
  state.progress.review_text = 'An excellent ending';
  render(<BookReview bookId="book" />);
  expect(screen.getByRole('textbox')).toHaveValue('An excellent ending');
  expect(screen.getByRole('button', { name: '5 stars' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Update review' })).toBeEnabled();
});
it('allows reviews at 100% without manual completion', () => {
  state.progress.completed = false;
  state.progress.progress = 1;
  render(<BookReview bookId="book" />);
  expect(screen.getByRole('textbox')).toBeInTheDocument();
});
