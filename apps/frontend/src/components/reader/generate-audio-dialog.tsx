'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api-client';
import { Loader2, CheckCircle2, XCircle, Music } from 'lucide-react';

interface Voice {
  id: string;
  name: string;
  language: string;
}

interface TocItem {
  href: string;
  label: string;
}

interface GenerateAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  bookId: string;
  toc: TocItem[];
  onAudioGenerated: () => void;
}

type GenerationPhase = 'idle' | 'generating' | 'done' | 'error';

export function GenerateAudioDialog({ open, onOpenChange, bookId, toc, onAudioGenerated }: GenerateAudioDialogProps) {
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<string>('');
  const [generationPhase, setGenerationPhase] = useState<GenerationPhase>('idle');
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [errorMessage, setErrorMessage] = useState('');

  useEffect(() => {
    if (open) {
      setGenerationPhase('idle');
      setProgress({ current: 0, total: 0 });
      setErrorMessage('');
      api.get<Voice[]>('/tts/voices').then((v) => {
        setVoices(v);
        if (v.length > 0 && !selectedVoice) {
          setSelectedVoice(v[0].id);
        }
      }).catch(() => {});
    }
  }, [open]);

  const handleGenerate = async () => {
    if (!selectedVoice) return;
    setGenerationPhase('generating');
    setProgress({ current: 0, total: toc.length });

    try {
      const result = await api.post<any[]>(`/books/${bookId}/generate/audio`, {
        voice_id: selectedVoice,
        chapter_indices: null,
      });
      setProgress({ current: result.length, total: result.length });
      setGenerationPhase('done');
      onAudioGenerated();
    } catch (err: any) {
      setErrorMessage(err?.message || 'Generation failed');
      setGenerationPhase('error');
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    setTimeout(() => setGenerationPhase('idle'), 300);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Generate Audio</DialogTitle>
          <DialogDescription>
            Select a voice and generate audio for this book.
          </DialogDescription>
        </DialogHeader>

        {generationPhase === 'idle' && (
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Voice</label>
              <Select value={selectedVoice} onValueChange={setSelectedVoice}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a voice" />
                </SelectTrigger>
                <SelectContent>
                  {voices.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {v.name} ({v.language})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Chapters ({toc.length} total)</label>
              <p className="text-xs text-muted-foreground">
                All chapters will be generated. This may take several minutes.
              </p>
            </div>
          </div>
        )}

        {generationPhase === 'generating' && (
          <div className="space-y-4 py-4 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="text-sm font-medium">Generating audio...</p>
            <p className="text-xs text-muted-foreground">
              Chapter {progress.current + 1} of {progress.total}
            </p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-primary transition-all duration-300"
                style={{
                  width: progress.total > 0 ? `${((progress.current + 1) / progress.total) * 100}%` : '0%',
                }}
              />
            </div>
          </div>
        )}

        {generationPhase === 'done' && (
          <div className="space-y-4 py-4 text-center">
            <CheckCircle2 className="mx-auto h-8 w-8 text-green-500" />
            <p className="text-sm font-medium">Generation complete</p>
            <p className="text-xs text-muted-foreground">
              {progress.current} chapters generated successfully.
            </p>
          </div>
        )}

        {generationPhase === 'error' && (
          <div className="space-y-4 py-4 text-center">
            <XCircle className="mx-auto h-8 w-8 text-destructive" />
            <p className="text-sm font-medium text-destructive">Generation failed</p>
            <p className="text-xs text-muted-foreground">{errorMessage}</p>
          </div>
        )}

        <DialogFooter>
          {generationPhase === 'idle' && (
            <div className="flex w-full gap-2">
              <Button variant="outline" className="flex-1" onClick={handleClose}>
                Cancel
              </Button>
              <Button className="flex-1" onClick={handleGenerate} disabled={!selectedVoice}>
                <Music className="mr-1.5 h-4 w-4" />
                Generate
              </Button>
            </div>
          )}
          {(generationPhase === 'done' || generationPhase === 'error') && (
            <Button className="w-full" onClick={handleClose}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
