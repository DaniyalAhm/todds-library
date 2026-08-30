'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useCastwrightModels, useCastwrightHealth, useChapterTtsStatus, useGenerateChapterAudio } from '@/hooks/use-books';
import { Mic, Loader2, Check, AlertCircle, Play } from 'lucide-react';

export function CastwrightChapterGenerate({ bookId, chapterId, chapterIndex, chapterTitle, fileFormat }: { bookId: string; chapterId: string; chapterIndex: number; chapterTitle: string; fileFormat?: string }) {
  const { data: session } = useSession();
  const isAdmin = (session?.user as any)?.is_admin ?? (session?.user as any)?.isAdmin ?? false;
  const { data: health } = useCastwrightHealth();
  const { data: modelsData } = useCastwrightModels();
  const { data: status, refetch } = useChapterTtsStatus(bookId, chapterId);
  const gen = useGenerateChapterAudio(bookId, chapterId);
  const [ollamaModel, setOllamaModel] = useState<string>('');

  const isEpub = (fileFormat || '').toLowerCase() === 'epub';
  if (!isEpub) return null;
  if (!isAdmin) return null;

  const locked = status?.locked ?? false;
  const generated = status?.generated?.[0];
  const hasCompleted = generated?.status === 'completed' || (status?.files?.length ?? 0) > 0;
  const isProcessing = generated?.status === 'processing' || gen.isPending;

  const handleGenerate = async (overwrite = false) => {
    try {
      await gen.mutateAsync({ ollama_model: ollamaModel || undefined, overwrite });
      refetch();
    } catch {}
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <Badge variant={hasCompleted ? 'default' : isProcessing ? 'secondary' : 'outline'} className="text-xs">
        {isProcessing ? 'Generating…' : hasCompleted ? 'Audio ready' : 'No audio'}
      </Badge>
      {health && !health.enabled && <span className="text-xs text-muted-foreground">Castwright disabled</span>}
      {health?.error && <span className="text-xs text-destructive">Castwright unreachable</span>}
      {modelsData?.models && modelsData.models.length > 0 && (
        <select value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} className="h-8 rounded border bg-background px-2 text-xs">
          <option value="">Ollama default</option>
          {modelsData.models.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
      )}
      {!hasCompleted ? (
        <Button size="sm" variant="outline" disabled={gen.isPending || locked} onClick={() => handleGenerate(false)}>
          {gen.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Mic className="mr-1 h-3 w-3" />}
          {locked ? 'Busy (one at a time)' : `Generate Ch. ${chapterIndex}`}
        </Button>
      ) : (
        <Button size="sm" variant="outline" disabled={gen.isPending || locked} onClick={() => handleGenerate(true)}>
          {gen.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Mic className="mr-1 h-3 w-3" />}
          Regenerate
        </Button>
      )}
      {hasCompleted && (
        <a href={`/backend-api/books/${bookId}/chapters/${chapterId}/audio/stream`} target="_blank" rel="noreferrer">
          <Button size="sm" variant="ghost"><Play className="mr-1 h-3 w-3" />Play</Button>
        </a>
      )}
      {gen.isError && <span className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="h-3 w-3" />{(gen.error as any)?.message || 'Failed'}</span>}
      {generated?.ollama_model && <span className="text-xs text-muted-foreground">model: {generated.ollama_model}</span>}
    </div>
  );
}
