'use client';

import { useQuery } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { api, getApiUrl } from '@/lib/api-client';
import { useState, useEffect } from 'react';

interface SearchParams {
  query: string;
  type?: string;
  limit?: number;
  offset?: number;
}

export function useSearch(params: SearchParams) {
  const { query, type, limit = 20, offset = 0 } = params;
  const { data: session } = useSession();

  const withAccessToken = (url: string) => {
    if (!session?.accessToken) return url;
    const nextUrl = new URL(url);
    nextUrl.searchParams.set('access_token', session.accessToken);
    return nextUrl.toString();
  };

  return useQuery({
    queryKey: ['search', query, type, limit, offset, session?.accessToken],
    queryFn: async () => {
      const data = await api.get<{ results: any[]; total: number }>('/search', {
        headers: session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : undefined,
        params: { q: query, type, limit: String(limit), offset: String(offset) } as Record<string, string | number | boolean | undefined>,
      });
      return {
        ...data,
        items: data.results.map((book) => ({
	          ...book,
	          format: book.file_format,
	          cover: book.cover_path ? withAccessToken(getApiUrl(`/books/${book.id}/cover`)) : undefined,
	          download_url: withAccessToken(getApiUrl(`/books/${book.id}/download`)),
	          stream_url: withAccessToken(getApiUrl(`/audiobooks/${book.id}/stream`)),
	        })),
      };
    },
    enabled: query.length >= 2 && !!session?.accessToken,
  });
}

export function useDebouncedSearch(delay: number = 300) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), delay);
    return () => clearTimeout(timer);
  }, [query, delay]);

  return {
    query,
    debouncedQuery,
    setQuery,
    searchResults: useSearch({ query: debouncedQuery }),
  };
}
