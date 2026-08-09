'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

interface SystemSettings {
  settings: {
    asr_device: string;
    asr_gpu_index: string;
    asr_compute_type: string;
    asr_model_id: string;
    subtitle_gen_mode: string;
    auto_gen_language: string;
    batch_size: string;
    chunk_length_s: string;
    vad_filter: string;
    chapter_gap_threshold_sec: string;
  };
  gpu: {
    available: boolean;
    device_count: number;
    device_name: string | null;
    devices: Array<{
      index: number;
      name: string;
      compute_capability: string;
    }>;
    driver_version: string | null;
  };
}

export function useSystemSettings() {
  return useQuery<SystemSettings>({
    queryKey: ['system-settings'],
    queryFn: () => api.get<SystemSettings>('/settings'),
  });
}

export function useUpdateSystemSettings() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (settings: Record<string, string>) =>
      api.put<SystemSettings>('/settings', settings),
    onSuccess: (data) => {
      queryClient.setQueryData(['system-settings'], data);
    },
  });
}

export function useGenerateAllSubtitles() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/settings/generate-all-subtitles'),
    onSuccess: (data: any) => {
      queryClient.setQueryData(['generation-logs'], (old: any) => ({
        ...old,
        running: data.running,
      }));
    },
  });
}

export function useGenerateAllChapters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/settings/generate-all-chapters'),
    onSuccess: (data: any) => {
      queryClient.setQueryData(['generation-logs'], (old: any) => ({
        ...old,
        running: data.running,
      }));
    },
  });
}

export interface GenerationLogEntry {
  id: string;
  book_id: string | null;
  chapter_id: string | null;
  chapter_index: number | null;
  book_title: string | null;
  status: string;
  message: string | null;
  created_at: string | null;
}

export function useCancelGeneration() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/settings/cancel-generation'),
    onSuccess: (data: any) => {
      queryClient.setQueryData(['generation-logs'], (old: any) => ({
        ...old,
        running: data.running,
      }));
    },
  });
}

export function useGenerationLogs() {
  return useQuery<{ running: boolean; logs: GenerationLogEntry[] }>({
    queryKey: ['generation-logs'],
    queryFn: () => api.get('/settings/generation-logs'),
    refetchInterval: 3000,
  });
}
