'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SettingField } from '@/components/settings/setting-field';
import { Gauge } from 'lucide-react';

interface TranscriptionPerfCardProps {
  batchSize: string;
  chunkLengthS: string;
  vadFilter: string;
  onChange: (key: 'batch_size' | 'chunk_length_s' | 'vad_filter', value: string) => void;
}

export function TranscriptionPerfCard({ batchSize, chunkLengthS, vadFilter, onChange }: TranscriptionPerfCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Gauge className="h-5 w-5 text-primary" />
          <CardTitle>Performance</CardTitle>
        </div>
        <CardDescription>Throughput and memory tradeoffs for transcription.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SettingField label="Batch Size" description="Chunks processed in parallel. Higher values are faster but use more VRAM — lower it if generation fails with CUDA out of memory. (1–32)">
          <Input type="number" min={1} max={32} step={1} value={batchSize} onChange={(e) => onChange('batch_size', e.target.value)} />
        </SettingField>
        <SettingField label="Chunk Length (seconds)" description="Audio segment length per inference. Longer chunks reduce overhead but use more memory. (10–120)">
          <Input type="number" min={10} max={120} step={5} value={chunkLengthS} onChange={(e) => onChange('chunk_length_s', e.target.value)} />
        </SettingField>
        <div className="flex items-center gap-3">
          <Input
            type="checkbox"
            id="vad-filter"
            checked={vadFilter === 'true'}
            onChange={(e) => onChange('vad_filter', e.target.checked ? 'true' : 'false')}
            className="h-4 w-4"
          />
          <label htmlFor="vad-filter" className="cursor-pointer text-sm font-medium text-foreground">
            VAD Filter
          </label>
          <p className="text-xs text-muted-foreground">Silero VAD ignores non-speech audio.</p>
        </div>
      </CardContent>
    </Card>
  );
}
