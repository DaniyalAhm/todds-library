import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { MarkBookComplete } from './mark-book-complete';

const state = vi.hoisted(() => ({ progress: { progress: 0.85, completed: false }, mutate: vi.fn() }));
vi.mock('@/hooks/use-books', () => ({
  useBookProgress: () => ({ data: state.progress }),
  useCompleteBook: () => ({ mutate: state.mutate, isPending: false }),
}));
vi.mock('@/components/ui/toast', () => ({ toast: vi.fn() }));
beforeEach(() => { state.progress = { progress: 0.85, completed: false }; state.mutate.mockClear(); });

it('enables marking complete at exactly 85%', () => {
  render(<MarkBookComplete bookId="book" />);
  fireEvent.click(screen.getByRole('button', { name: 'Mark complete' }));
  expect(state.mutate).toHaveBeenCalledTimes(1);
});
it('keeps the action disabled below 85%, even if the displayed percentage rounds up', () => {
  state.progress.progress = 0.84999;
  render(<MarkBookComplete bookId="book" />);
  expect(screen.getByRole('button', { name: 'Mark complete' })).toBeDisabled();
});
it('shows completion after marking a partially read book complete', () => {
  state.progress.completed = true;
  render(<MarkBookComplete bookId="book" />);
  expect(screen.getByText('Completed')).toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
