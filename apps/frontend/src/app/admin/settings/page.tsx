'use client';

import { useState, useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useSystemSettings, useUpdateSystemSettings, useGenerateAllSubtitles, useCancelGeneration, useGenerationLogs, type GenerationLogEntry } from '@/hooks/use-settings';
import { Cpu, Save, CheckCircle2, XCircle, HardDrive, FileAudio, Loader2, ScrollText, Square } from 'lucide-react';

const ASR_MODELS = [
  { value: 'tiny', label: 'Faster-Whisper Tiny' },
  { value: 'base', label: 'Faster-Whisper Base' },
  { value: 'small', label: 'Faster-Whisper Small' },
  { value: 'medium', label: 'Faster-Whisper Medium' },
  { value: 'large-v1', label: 'Faster-Whisper Large v1' },
  { value: 'large-v2', label: 'Faster-Whisper Large v2' },
  { value: 'large-v3', label: 'Faster-Whisper Large v3' },
  { value: 'turbo', label: 'Faster-Whisper Turbo' },
];

const DEVICE_OPTIONS = [
  { value: 'auto', label: 'Auto (prefer GPU)' },
  { value: 'cuda', label: 'CUDA (force GPU)' },
  { value: 'cpu', label: 'CPU (force)' },
];

const COMPUTE_TYPE_OPTIONS = [
  { value: 'float32', label: 'Float32' },
  { value: 'float16', label: 'Float16' },
];

const GEN_MODE_OPTIONS = [
  { value: 'manual', label: 'Manual — transcribe on demand from the player' },
  { value: 'auto_new', label: 'Auto for new books — only on first scan' },
  { value: 'auto_all', label: 'Auto for all — generate on every scan (new + updated)' },
];

const LANGUAGE_OPTIONS = [
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

function LogBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    started: { label: 'Started', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' },
    progress: { label: 'Progress', cls: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200' },
    completed: { label: 'Completed', cls: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' },
    failed: { label: 'Failed', cls: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' },
    skipped: { label: 'Skipped', cls: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200' },
    cancelled: { label: 'Cancelled', cls: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200' },
  };
  const entry = map[status] || { label: status, cls: 'bg-gray-100 text-gray-800' };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${entry.cls}`}>{entry.label}</span>;
}

function errorMessage(error: unknown, fallback: string) {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message)
    : fallback;
}

export default function SettingsPage() {
  const { data, isLoading, isError } = useSystemSettings();
  const updateSettings = useUpdateSystemSettings();
  const generateAll = useGenerateAllSubtitles();
  const cancelGeneration = useCancelGeneration();
  const { data: logsData } = useGenerationLogs();
  const logEndRef = useRef<HTMLDivElement>(null);

  const [asrDevice, setAsrDevice] = useState('auto');
  const [asrGpuIndex, setAsrGpuIndex] = useState('0');
  const [asrComputeType, setAsrComputeType] = useState('float32');
  const [asrModelId, setAsrModelId] = useState('small');
  const [subtitleGenMode, setSubtitleGenMode] = useState('manual');
  const [autoGenLanguage, setAutoGenLanguage] = useState('auto');
  const [batchSize, setBatchSize] = useState('1');
  const [chunkLengthS, setChunkLengthS] = useState('30');
  const [vadFilter, setVadFilter] = useState('false');
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setAsrDevice(data.settings.asr_device);
      setAsrGpuIndex(data.settings.asr_gpu_index || '0');
      setAsrComputeType(data.settings.asr_compute_type || 'float32');
      setAsrModelId(data.settings.asr_model_id);
      setSubtitleGenMode(data.settings.subtitle_gen_mode);
      setAutoGenLanguage(data.settings.auto_gen_language);
      setBatchSize(data.settings.batch_size);
      setChunkLengthS(data.settings.chunk_length_s);
      setVadFilter(data.settings.vad_filter);
    }
  }, [data]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logsData?.logs]);

  const handleSave = () => {
    updateSettings.mutate({
      asr_device: asrDevice,
      asr_gpu_index: asrGpuIndex,
      asr_compute_type: asrComputeType,
      asr_model_id: asrModelId,
      subtitle_gen_mode: subtitleGenMode,
      auto_gen_language: autoGenLanguage,
      batch_size: batchSize,
      chunk_length_s: chunkLengthS,
      vad_filter: vadFilter,
    });
    setDirty(false);
  };

  const latestLog = logsData?.logs.length ? logsData.logs[logsData.logs.length - 1] : null;
  const latestUpdateLabel = latestLog?.created_at
    ? new Date(latestLog.created_at).toLocaleString()
    : null;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground sm:text-3xl">System Settings</h1>
        <p className="mt-1 text-muted-foreground">
          Faster-Whisper subtitle generation and hardware configuration
        </p>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      ) : isError ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            Failed to load settings.
          </CardContent>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <Cpu className="h-5 w-5 text-primary" />
                <CardTitle>GPU Status</CardTitle>
              </div>
              <CardDescription>
                Detected hardware acceleration
              </CardDescription>
            </CardHeader>
            <CardContent>
              {data?.gpu.available ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <CheckCircle2 className="h-5 w-5 text-green-500" />
                    <span className="font-medium text-foreground">GPU Available</span>
                    <Badge variant="secondary">{data.gpu.device_name}</Badge>
                  </div>
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <HardDrive className="h-4 w-4" />
                    <span>{data.gpu.device_count} device(s) · CUDA {data.gpu.driver_version}</span>
                  </div>
                  {data.gpu.devices.length > 0 && (
                    <div className="space-y-1 pt-2">
                      {data.gpu.devices.map((device) => (
                        <div key={device.index} className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Badge variant={String(device.index) === asrGpuIndex ? 'default' : 'outline'}>
                            GPU {device.index}
                          </Badge>
                          <span>{device.name}</span>
                          <span>CC {device.compute_capability}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <XCircle className="h-5 w-5 text-muted-foreground" />
                  <span className="text-muted-foreground">No GPU detected — using CPU</span>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <HardDrive className="h-5 w-5 text-primary" />
                <CardTitle>ASR Configuration</CardTitle>
              </div>
              <CardDescription>
                Faster-Whisper model and device settings
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Device</label>
                <select
                  value={asrDevice}
                  onChange={(e) => { setAsrDevice(e.target.value); setDirty(true); }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {DEVICE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Changes take effect on the next transcription. The faster-whisper model will reload automatically.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">GPU</label>
                <select
                  value={asrGpuIndex}
                  onChange={(e) => { setAsrGpuIndex(e.target.value); setDirty(true); }}
                  disabled={asrDevice === 'cpu' || !data?.gpu.available || !data.gpu.devices.length}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {(data?.gpu.devices || []).map((device) => (
                    <option key={device.index} value={String(device.index)}>
                      GPU {device.index} - {device.name} (CC {device.compute_capability})
                    </option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Selects the CUDA device index passed to faster-whisper. Changes take effect on the next model reload.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Compute Type</label>
                <select
                  value={asrComputeType}
                  onChange={(e) => { setAsrComputeType(e.target.value); setDirty(true); }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {COMPUTE_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Float32 is more compatible; Float16 can be faster on supported CUDA backends.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">ASR Model</label>
                <select
                  value={asrModelId}
                  onChange={(e) => { setAsrModelId(e.target.value); setDirty(true); }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {ASR_MODELS.map((model) => (
                    <option key={model.value} value={model.value}>{model.label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Larger models are more accurate but slower and require more VRAM.
                  The compatible CTranslate2 model will be downloaded on first use.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Subtitle Generation Mode</label>
                <select
                  value={subtitleGenMode}
                  onChange={(e) => { setSubtitleGenMode(e.target.value); setDirty(true); }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {GEN_MODE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Controls when subtitles are automatically generated during library scans.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Auto-Generation Language</label>
                <select
                  value={autoGenLanguage}
                  onChange={(e) => { setAutoGenLanguage(e.target.value); setDirty(true); }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                >
                  {LANGUAGE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <p className="text-xs text-muted-foreground">
                  Language hint for auto-generated subtitles. Auto-detect works well for most cases.
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Batch Size</label>
                <input
                  type="number"
                  min={1}
                  max={16}
                  value={batchSize}
                  onChange={(e) => { setBatchSize(e.target.value); setDirty(true); }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  Number of audio chunks processed in parallel. Higher values use more VRAM but can speed up transcription. (1-16)
                </p>
              </div>

              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">Chunk Length (seconds)</label>
                <input
                  type="number"
                  min={10}
                  max={120}
                  step={5}
                  value={chunkLengthS}
                  onChange={(e) => { setChunkLengthS(e.target.value); setDirty(true); }}
                  className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  Duration of each audio segment fed to faster-whisper. Longer chunks reduce overhead but use more memory. (10-120)
                </p>
              </div>

              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="vad-filter"
                  checked={vadFilter === 'true'}
                  onChange={(e) => { setVadFilter(e.target.checked ? 'true' : 'false'); setDirty(true); }}
                  className="h-4 w-4 rounded border-border bg-background text-primary"
                />
                <label htmlFor="vad-filter" className="text-sm font-medium text-foreground cursor-pointer">
                  VAD Filter
                </label>
                <p className="text-xs text-muted-foreground">
                  Uses faster-whisper&apos;s Silero VAD to ignore non-speech audio.
                </p>
              </div>

              <Button
                onClick={handleSave}
                disabled={!dirty || updateSettings.isPending}
              >
                <Save className="mr-2 h-4 w-4" />
                {updateSettings.isPending ? 'Saving...' : 'Save Settings'}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <FileAudio className="h-5 w-5 text-primary" />
                <CardTitle>Bulk Subtitle Generation</CardTitle>
              </div>
              <CardDescription>
                Generate subtitles for all existing audiobook chapters that don&apos;t have them yet
              </CardDescription>
            </CardHeader>
            <CardContent>
              {logsData?.running ? (
                <Button
                  variant="destructive"
                  onClick={() => cancelGeneration.mutate()}
                  disabled={cancelGeneration.isPending}
                >
                  {cancelGeneration.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Stopping...
                    </>
                  ) : (
                    <>
                      <Square className="mr-2 h-4 w-4" />
                      Stop Generation
                    </>
                  )}
                </Button>
              ) : (
                <Button
                  onClick={() => generateAll.mutate()}
                  disabled={generateAll.isPending}
                >
                  {generateAll.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Generating...
                    </>
                  ) : (
                    <>
                      <FileAudio className="mr-2 h-4 w-4" />
                      Generate for All Books
                    </>
                  )}
                </Button>
              )}
              {generateAll.isSuccess && (
                <p className="mt-2 text-sm text-green-600">
                  Generation started in the background.
                </p>
              )}
              {generateAll.isError && (
                <p className="mt-2 text-sm text-red-600">
                  {errorMessage(generateAll.error, 'Failed to start generation.')}
                </p>
              )}
              {cancelGeneration.isSuccess && (
                <p className="mt-2 text-sm text-orange-600">
                  Cancel request sent. Generation will stop after the current chapter.
                </p>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                This runs all chapters sequentially in the background. Large libraries may take a while.
                Only chapters without existing subtitles will be processed.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center gap-2">
                <ScrollText className="h-5 w-5 text-primary" />
                <CardTitle>Generation Logs</CardTitle>
              </div>
              <CardDescription>
                Live feed of subtitle generation activity
              </CardDescription>
            </CardHeader>
            <CardContent>
              {latestUpdateLabel && (
                <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span>Last update</span>
                  <span>{latestUpdateLabel}</span>
                </div>
              )}
              <div className="max-h-80 overflow-y-auto space-y-1 rounded-md border border-border p-2 bg-muted/30 text-xs font-mono">
                {logsData?.logs.length === 0 && (
                  <p className="text-muted-foreground p-2">No generation activity yet.</p>
                )}
                {logsData?.logs.map((entry: GenerationLogEntry) => (
                  <div key={entry.id} className="flex items-start gap-2 p-1.5 rounded hover:bg-muted/50">
                    <span className="text-muted-foreground shrink-0 w-16 truncate">
                      {entry.created_at ? new Date(entry.created_at).toLocaleTimeString() : ''}
                    </span>
                    <LogBadge status={entry.status} />
                    <span className="text-foreground truncate">
                      {entry.book_title ? `${entry.book_title}${entry.chapter_index != null ? ` — Ch ${entry.chapter_index}` : ''}` : entry.book_id || ''}
                    </span>
                    <span className="text-muted-foreground truncate">{entry.message}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
