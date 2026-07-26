'use client';

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { formatDurationDetailed } from '@/lib/utils';
import {
  Play,
  Pause,
  SkipBack,
  SkipForward,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

interface PlayerControlsProps {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onSkipBack: () => void;
  onSkipForward: () => void;
  onPrevChapter?: () => void;
  onNextChapter?: () => void;
  className?: string;
}

export function PlayerControls({
  isPlaying,
  currentTime,
  duration,
  onPlayPause,
  onSeek,
  onSkipBack,
  onSkipForward,
  onPrevChapter,
  onNextChapter,
  className,
}: PlayerControlsProps) {
  return (
    <div className={cn('flex flex-col gap-2', className)}>
      <div className="flex items-center justify-center gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={onPrevChapter}
          className="h-8 w-8"
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onSkipBack}
          className="h-10 w-10"
        >
          <SkipBack className="h-5 w-5" />
        </Button>
        <Button
          variant="secondary"
          size="icon"
          onClick={onPlayPause}
          className="h-12 w-12 rounded-full"
        >
          {isPlaying ? (
            <Pause className="h-6 w-6" />
          ) : (
            <Play className="h-6 w-6 pl-0.5" />
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onSkipForward}
          className="h-10 w-10"
        >
          <SkipForward className="h-5 w-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={onNextChapter}
          className="h-8 w-8"
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
          {formatDurationDetailed(currentTime)}
        </span>
        <Slider
          value={[currentTime]}
          max={duration || 100}
          step={1}
          onValueChange={([v]) => onSeek(v)}
          className="flex-1"
        />
        <span className="w-12 text-left text-xs tabular-nums text-muted-foreground">
          -{formatDurationDetailed(Math.max(0, duration - currentTime))}
        </span>
      </div>
    </div>
  );
}
