'use client';

import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useSystemSettings,
  useUpdateSystemSettings,
  useGenerateAllSubtitles,
  useGenerateAllChapters,
  useCancelGeneration,
  useGenerationLogs,
} from '@/hooks/use-settings';
import { useSystemSettingsForm } from '@/hooks/use-system-settings-form';
import { StickySaveBar } from '@/components/settings/sticky-save-bar';
import { HardwareStatusCard } from '@/components/admin/settings/hardware-status-card';
import { TranscriptionModelCard } from '@/components/admin/settings/transcription-model-card';
import { TranscriptionPerfCard } from '@/components/admin/settings/transcription-perf-card';
import { AutomationCard } from '@/components/admin/settings/automation-card';
import { BulkJobCard } from '@/components/admin/settings/bulk-job-card';
import { GenerationLogsCard } from '@/components/admin/settings/generation-logs-card';
import { FileAudio, ListTree, Square } from 'lucide-react';

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div className="pt-2">
      <h2 className="text-lg font-semibold text-foreground">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

export default function SettingsPage() {
  const { data, isLoading, isError } = useSystemSettings();
  const updateSettings = useUpdateSystemSettings();
  const generateAll = useGenerateAllSubtitles();
  const generateAllChapters = useGenerateAllChapters();
  const cancelGeneration = useCancelGeneration();
  const { data: logsData } = useGenerationLogs();

  const { values, setField, dirty, reset } = useSystemSettingsForm(
    data
      ? {
          asr_device: data.settings.asr_device,
          asr_gpu_index: data.settings.asr_gpu_index || '0',
          asr_compute_type: data.settings.asr_compute_type || 'float32',
          asr_model_id: data.settings.asr_model_id,
          subtitle_gen_mode: data.settings.subtitle_gen_mode,
          auto_gen_language: data.settings.auto_gen_language,
          batch_size: data.settings.batch_size,
          chunk_length_s: data.settings.chunk_length_s,
          vad_filter: data.settings.vad_filter,
          chapter_gap_threshold_sec: data.settings.chapter_gap_threshold_sec,
        }
      : undefined
  );

  const handleSave = () => {
    updateSettings.mutate({ ...values });
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Subtitle Generation Settings</h1>
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
          <section aria-label="Hardware" className="space-y-4">
            <SectionHeading title="Hardware" description="What the server can use for transcription." />
            <HardwareStatusCard
              available={!!data?.gpu.available}
              deviceCount={data?.gpu.device_count || 0}
              deviceName={data?.gpu.device_name || null}
              driverVersion={data?.gpu.driver_version || null}
              devices={data?.gpu.devices || []}
              selectedGpuIndex={values.asr_gpu_index}
            />
          </section>

          <section aria-label="Transcription" className="space-y-4">
            <SectionHeading title="Transcription" description="Model choice and performance tuning." />
            <TranscriptionModelCard
              asrDevice={values.asr_device}
              asrGpuIndex={values.asr_gpu_index}
              asrComputeType={values.asr_compute_type}
              asrModelId={values.asr_model_id}
              gpuAvailable={!!data?.gpu.available}
              gpuDevices={data?.gpu.devices || []}
              onChange={setField}
            />
            <TranscriptionPerfCard
              batchSize={values.batch_size}
              chunkLengthS={values.chunk_length_s}
              vadFilter={values.vad_filter}
              onChange={setField}
            />
          </section>

          <section aria-label="Automation" className="space-y-4">
            <SectionHeading title="Automation" description="When subtitles and chapters are created automatically." />
            <AutomationCard
              subtitleGenMode={values.subtitle_gen_mode}
              autoGenLanguage={values.auto_gen_language}
              chapterGapThreshold={values.chapter_gap_threshold_sec}
              onChange={setField}
            />
          </section>

          <StickySaveBar
            dirty={dirty}
            saving={updateSettings.isPending}
            onSave={handleSave}
            onReset={reset}
            error={
              updateSettings.isError
                ? typeof updateSettings.error === 'object' &&
                  updateSettings.error !== null &&
                  'message' in updateSettings.error
                  ? String((updateSettings.error as { message?: unknown }).message)
                  : 'Could not save settings.'
                : null
            }
          />

          <section aria-label="Bulk jobs" className="space-y-4">
            <SectionHeading title="Bulk jobs" description="Backfill work that runs in the background." />
            <BulkJobCard
              icon={<FileAudio className="h-5 w-5 text-primary" />}
              title="Bulk Subtitle Generation"
              description="Generate subtitles for all existing audiobook chapters that don't have them yet"
              hint="This runs all chapters sequentially in the background. Large libraries may take a while. Only chapters without existing subtitles will be processed."
              actionLabel={<><FileAudio className="mr-2 h-4 w-4" />Generate for All Books</>}
              pending={generateAll.isPending}
              isSuccess={generateAll.isSuccess}
              successMessage="Generation started in the background."
              error={generateAll.error}
              isError={generateAll.isError}
              running={!!logsData?.running}
              stopPending={cancelGeneration.isPending}
              stopLabel={<><Square className="mr-2 h-4 w-4" />Stop Generation</>}
              onStart={() => generateAll.mutate()}
              onStop={() => cancelGeneration.mutate()}
            />
            {cancelGeneration.isSuccess && (
              <p className="text-sm text-orange-600">
                Cancel request sent. Generation will stop after the current chapter.
              </p>
            )}
            <BulkJobCard
              icon={<ListTree className="h-5 w-5 text-primary" />}
              title="Bulk Chapter Detection"
              description="Detect chapter boundaries from whisper timestamps for all single-file audiobooks without chapters"
              hint="Runs transcription sequentially in the background. Multi-track books and books that already have chapters are skipped. Uses the gap threshold from settings."
              actionLabel={<><ListTree className="mr-2 h-4 w-4" />Generate Chapters for All Books</>}
              pending={generateAllChapters.isPending}
              isSuccess={generateAllChapters.isSuccess}
              successMessage="Chapter detection started in the background."
              error={generateAllChapters.error}
              isError={generateAllChapters.isError}
              running={false}
              onStart={() => generateAllChapters.mutate()}
            />
          </section>

          <section aria-label="Logs" className="space-y-4">
            <SectionHeading title="Logs" description="Live feed of generation activity." />
            <GenerationLogsCard logs={logsData?.logs || []} />
          </section>
        </>
      )}
    </div>
  );
}
