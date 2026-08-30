'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useSession } from 'next-auth/react';
import { api, getAccessToken, getApiUrl } from '@/lib/api-client';

interface BooksQueryParams {
  limit?: number;
  offset?: number;
  library_id?: string;
  format?: string;
  search?: string;
  author?: string;
  series?: string;
  sort?: string;
  order?: 'asc' | 'desc';
}

interface BookProgress {
  id: string;
  book_id: string;
  user_id: string;
  progress: number;
  position: number;
  location?: string | null;
  last_updated: string;
}

interface Bookmark {
  id: string;
  book_id: string;
  user_id: string;
  note?: string;
  position: number;
  location?: string | null;
  created_at: string;
}

interface Book {
  id: string;
  library_id: string;
  title: string;
  author?: string | null;
  series?: string | null;
  series_index?: number | null;
  isbn?: string | null;
  asin?: string | null;
  description?: string | null;
  publisher?: string | null;
  published_date?: string | null;
  language?: string | null;
  page_count?: number | null;
  duration?: number | null;
  file_path: string;
  file_format: string;
  file_size: number;
  cover_path?: string | null;
  file_hash?: string | null;
  has_ebook: boolean;
  has_audiobook: boolean;
  ebook_format?: string | null;
  audiobook_format?: string | null;
  audio_track_count?: number;
  progress?: number;
  chapters?: Array<{ id: string; index: number; title: string; start_position?: number | null; end_position?: number | null }>;
  created_at: string;
  updated_at: string;
  format: string;
  cover?: string;
  download_url: string;
  audio_download_url: string;
  stream_url: string;
}

export function withAccessToken(url: string, token?: string | null): string {
  if (!token) return url;
  const nextUrl = new URL(url);
  nextUrl.searchParams.set('access_token', token);
  return nextUrl.toString();
}

function authConfig(token?: string | null) {
  return token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
}

function normalizeBook(book: Omit<Book, 'format' | 'cover' | 'download_url' | 'audio_download_url' | 'stream_url'>, token?: string | null): Book {
  // Prefer the live in-memory token (kept fresh by the auth keep-alive) so
  // media URLs are baked with the most recent access token available.
  const access = getAccessToken() ?? token;
  return {
    ...book,
    format: book.file_format,
    cover: book.cover_path ? withAccessToken(getApiUrl(`/books/${book.id}/cover`), access) : undefined,
    download_url: withAccessToken(getApiUrl(`/books/${book.id}/download`), access),
    audio_download_url: withAccessToken(getApiUrl(`/audiobooks/${book.id}/download`), access),
    stream_url: withAccessToken(getApiUrl(`/audiobooks/${book.id}/stream`), access),
  };
}

export function useBooks(params?: BooksQueryParams) {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ['books', params, session?.accessToken],
    queryFn: async () => {
      const data = await api.get<{ items: Array<Omit<Book, 'format' | 'cover' | 'download_url' | 'audio_download_url' | 'stream_url'>>; total: number; limit: number; offset: number }>(
        '/books',
        {
          ...authConfig(session?.accessToken),
          params: params as Record<string, string | number | boolean | undefined>,
        }
      );
      return {
        ...data,
        items: data.items.map((book) => normalizeBook(book, session?.accessToken)),
      };
    },
    enabled: !!session?.accessToken,
  });
}

export function useBook(id: string) {
  const { data: session } = useSession();
  return useQuery({
    queryKey: ['book', id, session?.accessToken],
    queryFn: async () => normalizeBook(
      await api.get<Omit<Book, 'format' | 'cover' | 'download_url' | 'audio_download_url' | 'stream_url'>>(
        `/books/${id}`,
        authConfig(session?.accessToken)
      ),
      session?.accessToken
    ),
    enabled: !!id && !!session?.accessToken,
  });
}

export function useBookProgress(bookId: string) {
  return useQuery({
    queryKey: ['book-progress', bookId],
    queryFn: () => api.get<BookProgress>(`/books/${bookId}/progress`),
    enabled: !!bookId,
  });
}

export function useUpdateProgress(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { progress: number; position: number; location?: string | null }) =>
      api.post(`/books/${bookId}/progress`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book-progress', bookId] });
      queryClient.invalidateQueries({ queryKey: ['book', bookId] });
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

export function useBookmarks(bookId: string) {
  return useQuery({
    queryKey: ['bookmarks', bookId],
    queryFn: () => api.get<Bookmark[]>(`/books/${bookId}/bookmarks`),
    enabled: !!bookId,
  });
}

export function useCreateBookmark(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { position: number; location?: string | null; note?: string }) =>
      api.post(`/books/${bookId}/bookmarks`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks', bookId] });
    },
  });
}

export function useDeleteBookmark(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (bookmarkId: string) => api.delete(`/books/${bookId}/bookmarks/${bookmarkId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bookmarks', bookId] });
    },
  });
}

export function useUpdateBookMetadata(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (
      data: Partial<
        Pick<
          Book,
          | 'title'
          | 'author'
          | 'series'
          | 'isbn'
          | 'description'
          | 'publisher'
          | 'published_date'
          | 'language'
          | 'page_count'
          | 'duration'
        >
      >
    ) => api.put(`/metadata/${bookId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', bookId] });
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

export function useGenerateChapterSubtitles(bookId: string) {
  return useMutation({
    mutationFn: ({ chapterId, overwrite }: { chapterId: string; overwrite?: boolean }) =>
      api.post<{ status: string; subtitle_path: string; chapter_id: string }>(
        `/books/${bookId}/chapters/${chapterId}/generate/subtitles`,
        undefined,
        overwrite ? { params: { overwrite: true } } : undefined
      ),
  });
}

export function useGenerateBookSubtitles(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ status: string; results: Array<{ chapter_id: string; status: string; error?: string }> }>(
        `/books/${bookId}/generate/subtitles`,
        { overwrite: true }
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', bookId] });
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

export function useGenerateChapters(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data?: { overwrite?: boolean; gap_threshold_sec?: number }) =>
      api.post<{ status: string; chapter_count: number; chapters: Array<{ index: number; title: string; start_position: number; end_position: number }> }>(
        `/books/${bookId}/generate/chapters`,
        data
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', bookId] });
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

export function useLookupBookMetadata(bookId: string) {
  return useMutation({
    mutationFn: (params?: { title?: string; author?: string; isbn?: string; asin?: string; refresh?: boolean }) =>
      api.get<{ results: Array<Partial<Book> & { source?: string; has_cover?: boolean; cached?: boolean }> }>(`/metadata/lookup/${bookId}`, {
        params: params as Record<string, string | number | boolean | undefined>,
      }),
  });
}

export function useApplyBookMetadata(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<Book> & { source?: string; has_cover?: boolean; cached?: boolean }) => api.post(`/metadata/apply/${bookId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', bookId] });
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

export function useRefreshBookMetadata(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post(`/metadata/refresh/${bookId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', bookId] });
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

export function useGenerateAudibleChapters(bookId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data?: { overwrite?: boolean }) =>
      api.post<{ status: string; chapter_count: number; chapters: Array<{ title: string; start_offset_ms: number; end_offset_ms: number }>; source: string }>(
        `/books/${bookId}/generate/audible-chapters`,
        undefined,
        data?.overwrite ? { params: { overwrite: true } } : undefined
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', bookId] });
      queryClient.invalidateQueries({ queryKey: ['books'] });
    },
  });
}

// ── Castwright TTS (chapter-by-chapter, admin-only, one-at-a-time) ───────
export function useCastwrightModels() {
  return useQuery({
    queryKey: ['castwright-models'],
    queryFn: () => api.get<{ models: string[]; ollama_url: string }>('/castwright/models'),
  });
}
export function useCastwrightHealth() {
  return useQuery({
    queryKey: ['castwright-health'],
    queryFn: () => api.get<{ enabled: boolean; url?: string; status?: number; error?: string }>('/castwright/health'),
  });
}
export function useChapterTtsStatus(bookId: string, chapterId: string) {
  return useQuery({
    queryKey: ['tts-chapter-status', bookId, chapterId],
    queryFn: () =>
      api.get<{
        book_id: string; chapter_id: string; chapter_index: number; locked: boolean;
        generated: Array<{ id: string; status: string; file_path: string; ollama_model?: string; created_at: string }>;
        files: string[]; logs: Array<{ status: string; message: string; created_at: string }>;
      }>(`/books/${bookId}/chapters/${chapterId}/generate/audio/status`),
    enabled: !!bookId && !!chapterId,
    refetchInterval: 5000,
  });
}
export function useBookTtsStatus(bookId: string) {
  return useQuery({
    queryKey: ['tts-book-status', bookId],
    queryFn: () =>
      api.get<{ book_id: string; locked: boolean; generated: Array<{ chapter_index: number; chapter_id?: string; status: string; file_path: string; created_at: string }> }>(
        `/books/${bookId}/generate/audio/status`
      ),
    enabled: !!bookId,
    refetchInterval: 7000,
  });
}
export function useGenerateChapterAudio(bookId: string, chapterId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { ollama_model?: string; tts_model_key?: string; overwrite?: boolean }) =>
      api.post<{ status: string; chapter_id: string; chapter_index: number; file_path: string }>(
        `/books/${bookId}/chapters/${chapterId}/generate/audio`,
        { ollama_model: data.ollama_model, tts_model_key: data.tts_model_key, overwrite: !!data.overwrite }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tts-chapter-status', bookId, chapterId] });
      qc.invalidateQueries({ queryKey: ['tts-book-status', bookId] });
      qc.invalidateQueries({ queryKey: ['book', bookId] });
    },
  });
}

export type { Book, Bookmark, BookProgress };
