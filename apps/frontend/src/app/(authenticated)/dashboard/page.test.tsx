import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import DashboardPage from './page';

const state = vi.hoisted(() => ({
  stats: { total: 20, in_progress: 3, completed: 5, not_started: 12, minutes_listened: 125 } as { total: number; in_progress: number; completed: number; not_started: number; minutes_listened: number } | undefined,
  loading: false,
  error: null as Error | null,
}));
vi.mock('next-auth/react', () => ({ useSession: () => ({ data: { user: { name: 'Todd' } } }) }));
vi.mock('@/hooks/use-books', () => ({
  useBookStats: () => ({ data: state.stats, isLoading: state.loading, error: state.error }),
  useBooks: () => ({ data: { items: [] }, isLoading: false, error: null }),
}));
vi.mock('@/components/books/book-grid', () => ({ BookGrid: () => <div /> }));
beforeEach(() => {
  state.stats = { total: 20, in_progress: 3, completed: 5, not_started: 12, minutes_listened: 125 };
  state.loading = false;
  state.error = null;
});
it('shows personal counts and library completion', () => {
  render(<DashboardPage />);
  expect(screen.getByText(/Welcome back, Todd/)).toBeInTheDocument();
  for (const count of ['20', '3', '5', '12', '125']) expect(screen.getByText(count)).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25');
});
it('handles an empty library', () => {
  state.stats = { total: 0, in_progress: 0, completed: 0, not_started: 0, minutes_listened: 0 };
  render(<DashboardPage />);
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
  expect(screen.getByText(/Add books to your library to start tracking/)).toBeInTheDocument();
});
it('reports stats failures without showing misleading zero counts', () => {
  state.stats = undefined;
  state.error = new Error('Failed');
  render(<DashboardPage />);
  expect(screen.getByRole('alert')).toHaveTextContent('Unable to load your reading stats');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});
