'use client';

import type { SettingOption } from '@/components/settings/setting-select';

export const ASR_MODELS: SettingOption[] = [
  { value: 'tiny', label: 'Faster-Whisper Tiny' },
  { value: 'base', label: 'Faster-Whisper Base' },
  { value: 'small', label: 'Faster-Whisper Small' },
  { value: 'medium', label: 'Faster-Whisper Medium' },
  { value: 'large-v1', label: 'Faster-Whisper Large v1' },
  { value: 'large-v2', label: 'Faster-Whisper Large v2' },
  { value: 'large-v3', label: 'Faster-Whisper Large v3' },
  { value: 'turbo', label: 'Faster-Whisper Turbo' },
];

export const DEVICE_OPTIONS: SettingOption[] = [
  { value: 'auto', label: 'Auto (prefer GPU)' },
  { value: 'cuda', label: 'CUDA (force GPU)' },
  { value: 'cpu', label: 'CPU (force)' },
];

export const COMPUTE_TYPE_OPTIONS: SettingOption[] = [
  { value: 'float32', label: 'Float32' },
  { value: 'float16', label: 'Float16' },
];

export const GEN_MODE_OPTIONS: SettingOption[] = [
  { value: 'manual', label: 'Manual — transcribe on demand from the player' },
  { value: 'auto_new', label: 'Auto for new books — only on first scan' },
  { value: 'auto_all', label: 'Auto for all — generate on every scan (new + updated)' },
];

export const LANGUAGE_OPTIONS: SettingOption[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ru', label: 'Russian' },
  { value: 'ar', label: 'Arabic' },
];

export function errorMessage(error: unknown, fallback: string) {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message)
    : fallback;
}
