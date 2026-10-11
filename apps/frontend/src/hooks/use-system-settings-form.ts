'use client';

import { useEffect, useMemo, useState } from 'react';

export interface SystemSettingsFormValues {
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
}

export const DEFAULT_FORM_VALUES: SystemSettingsFormValues = {
  asr_device: 'auto',
  asr_gpu_index: '0',
  asr_compute_type: 'float32',
  asr_model_id: 'small',
  subtitle_gen_mode: 'manual',
  auto_gen_language: 'auto',
  batch_size: '1',
  chunk_length_s: '30',
  vad_filter: 'false',
  chapter_gap_threshold_sec: '3.0',
};

export function useSystemSettingsForm(serverValues?: Partial<SystemSettingsFormValues>) {
  const initial = useMemo<SystemSettingsFormValues>(
    () => ({ ...DEFAULT_FORM_VALUES, ...(serverValues ?? {}) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(serverValues ?? {})]
  );
  const [values, setValues] = useState<SystemSettingsFormValues>(initial);

  useEffect(() => {
    setValues(initial);
  }, [initial]);

  const setField = (key: keyof SystemSettingsFormValues, value: string) =>
    setValues((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));

  const dirty = useMemo(
    () => Object.keys(DEFAULT_FORM_VALUES).some((k) => values[k as keyof SystemSettingsFormValues] !== initial[k as keyof SystemSettingsFormValues]),
    [values, initial]
  );

  const reset = () => setValues(initial);

  return { values, setField, dirty, reset, setValues };
}
