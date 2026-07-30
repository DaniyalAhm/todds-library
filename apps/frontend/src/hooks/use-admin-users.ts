'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface AdminUser {
  id: string;
  username: string;
  email: string;
  is_admin: boolean;
  authentik_sub: string | null;
  has_password: boolean;
  created_at: string;
  updated_at: string;
}

export interface AdminUserCreate {
  username: string;
  email: string;
  password: string;
  is_admin: boolean;
}

export interface AdminUserUpdate {
  username?: string;
  email?: string;
  password?: string;
  is_admin?: boolean;
}

export function useAdminUsers() {
  return useQuery<{ items: AdminUser[] }>({
    queryKey: ['admin-users'],
    queryFn: () => api.get('/auth/users'),
  });
}

export function useCreateAdminUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (payload: AdminUserCreate) => api.post<AdminUser>('/auth/users', payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
}

export function useUpdateAdminUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...payload }: AdminUserUpdate & { id: string }) =>
      api.patch<AdminUser>(`/auth/users/${encodeURIComponent(id)}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
}

export function useDeleteAdminUser() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/auth/users/${encodeURIComponent(id)}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
}
