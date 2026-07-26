'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

interface Library {
  id: string;
  name: string;
  path: string;
  type: string;
  book_count: number;
  created_at: string;
  updated_at: string;
}

interface DirectoryEntry {
  name: string;
  path: string;
  has_children: boolean;
}

interface DirectoryList {
  root: string;
  current: string;
  parent: string | null;
  items: DirectoryEntry[];
}

export function useLibraries() {
  return useQuery({
    queryKey: ['libraries'],
    queryFn: async () => {
      const response = await api.get<{ items: Library[] }>('/libraries');
      return response.items;
    },
  });
}

export function useLibraryDirectories(enabled: boolean, path?: string) {
  return useQuery({
    queryKey: ['library-directories', path || 'root'],
    queryFn: () => api.get<DirectoryList>('/libraries/directories', path ? { params: { path } } : undefined),
    enabled,
  });
}

export function useLibrary(id: string) {
  return useQuery({
    queryKey: ['library', id],
    queryFn: () => api.get<Library>(`/libraries/${id}`),
    enabled: !!id,
  });
}

export function useCreateLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; path: string; type: string }) =>
      api.post('/libraries', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
    },
  });
}

export function useDeleteLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/libraries/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
    },
  });
}

export function useScanLibrary() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (libraryId: string) => api.post(`/libraries/${libraryId}/scan`),
    onSuccess: (_, libraryId) => {
      queryClient.invalidateQueries({ queryKey: ['library', libraryId] });
      queryClient.invalidateQueries({ queryKey: ['libraries'] });
    },
  });
}

export type { DirectoryEntry, DirectoryList, Library };
