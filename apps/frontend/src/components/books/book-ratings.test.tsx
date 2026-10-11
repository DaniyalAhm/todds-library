import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { BookRatings } from './book-ratings';
const state = vi.hoisted(() => ({ data: { average_rating: 3.5, rating_count: 2, distribution: { '3': 1, '4': 1 } } }));
vi.mock('@/hooks/use-books', () => ({ useBookRatings: () => ({ data: state.data, isLoading: false, isError: false }) }));
it('shows shared average, rating count, and star distribution', () => {
  render(<BookRatings bookId="book" />);
  expect(screen.getByText('3.5 out of 5')).toBeInTheDocument();
  expect(screen.getByText('(2 ratings)')).toBeInTheDocument();
  expect(screen.getByLabelText('4 stars: 1 rating')).toBeInTheDocument();
});
it('shows the empty state', () => {
  state.data.rating_count = 0;
  render(<BookRatings bookId="book" />);
  expect(screen.getByText('No ratings yet.')).toBeInTheDocument();
});
