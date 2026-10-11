'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingField } from '@/components/settings/setting-field';
import { SettingSelect } from '@/components/settings/setting-select';
import { ASR_MODELS, DEVICE_OPTIONS, COMPUTE_TYPE_OPTIONS } from './constants';
import type { GpuDevice } from './hardware-status-card';
import { Boxes } from 'lucide-react';

interface TranscriptionModelCardProps {
  asrDevice: string;
  asrGpuIndex: string;
  asrComputeType: string;
  asrModelId: string;
  gpuAvailable: boolean;
  gpuDevices: GpuDevice[];
  onChange: (key: 'asr_device' | 'asr_gpu_index' | 'asr_compute_type' | 'asr_model_id', value: string) => void;
}

export function TranscriptionModelCard({ asrDevice, asrGpuIndex, asrComputeType, asrModelId, gpuAvailable, gpuDevices, onChange }: TranscriptionModelCardProps) {
  const gpuSelectOptions = gpuDevices.map((d) => ({
    value: String(d.index),
    label: `GPU ${d.index} - ${d.name} (CC ${d.compute_capability})`,
  }));

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Boxes className="h-5 w-5 text-primary" />
          <CardTitle>Model &amp; Device</CardTitle>
        </div>
        <CardDescription>Faster-Whisper model and hardware target. Changes apply on the next transcription.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SettingField label="ASR Model" description="Larger models are more accurate but slower and use more VRAM. Downloaded on first use.">
          <SettingSelect value={asrModelId} onChange={(v) => onChange('asr_model_id', v)} options={ASR_MODELS} ariaLabel="ASR Model" />
        </SettingField>
        <SettingField label="Device" description="The faster-whisper model reloads automatically on the next transcription.">
          <SettingSelect value={asrDevice} onChange={(v) => onChange('asr_device', v)} options={DEVICE_OPTIONS} ariaLabel="Device" />
        </SettingField>
        <SettingField label="GPU" description="CUDA device index passed to faster-whisper. Applies on the next model reload.">
          <SettingSelect
            value={asrGpuIndex}
            onChange={(v) => onChange('asr_gpu_index', v)}
            options={gpuSelectOptions.length ? gpuSelectOptions : [{ value: '0', label: 'No GPU devices detected' }]}
            disabled={asrDevice === 'cpu' || !gpuAvailable || gpuDevices.length === 0}
            ariaLabel="GPU"
          />
        </SettingField>
        <SettingField label="Compute Type" description="Float32 is more compatible; Float16 can be faster on supported CUDA backends.">
          <SettingSelect value={asrComputeType} onChange={(v) => onChange('asr_compute_type', v)} options={COMPUTE_TYPE_OPTIONS} ariaLabel="Compute Type" />
        </SettingField>
      </CardContent>
    </Card>
  );
}
