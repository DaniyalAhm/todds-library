'use client';

import Link from 'next/link';
import { Pause, Play, X, Headphones } from 'lucide-react';
import { usePlayer } from '@/hooks/use-player';
import { useAudioPlayer } from './audio-player-context';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { routes } from '@/lib/routes';
import { formatDurationDetailed } from '@/lib/utils';

export function MiniPlayer() {
  const { currentBook, currentBookInfo, currentTime, duration, isPlaying, setCurrentBook } = usePlayer();
  const audio = useAudioPlayer();

  if (!currentBook || !currentBookInfo) return null;

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;
  const listenHref = routes.bookListen(currentBook);

  const handleClose = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    audio.pause();
    setCurrentBook(null);
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/80 md:left-64 md:pl-0">
      {/* Progress bar */}
      <div className="h-0.5 w-full bg-muted">
        <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
      </div>
      <div className="flex items-center gap-3 px-3 py-2 sm:px-4">
        <Link href={listenHref} className="flex min-w-0 flex-1 items-center gap-3">
          <div className="h-10 w-10 shrink-0 overflow-hidden rounded bg-muted">
            {currentBookInfo.cover ? (
              <img src={currentBookInfo.cover} alt={currentBookInfo.title} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Headphones className="h-5 w-5 text-muted-foreground/50" />
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium leading-tight">{currentBookInfo.title}</p>
            {currentBookInfo.author && (
              <p className="truncate text-xs text-muted-foreground">{currentBookInfo.author}</p>
            )}
            <p className="hidden text-xs tabular-nums text-muted-foreground sm:block">
              {formatDurationDetailed(currentTime)} / {formatDurationDetailed(duration || 0)}
            </p>
          </div>
        </Link>

        <div className="flex items-center gap-1 sm:gap-2">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={audio.toggle} aria-label={isPlaying ? 'Pause' : 'Play'}>
            {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5 pl-0.5" />}
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={handleClose} aria-label="Close player">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Slider for precise seeking (hidden on very small, visible on sm+) */}
      <div className="hidden items-center gap-2 px-3 pb-2 sm:flex sm:px-4">
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">{formatDurationDetailed(currentTime)}</span>
        <Slider
          value={[currentTime]}
          max={duration || 100}
          step={1}
          onValueChange={([v]) => audio.seek(v)}
          className="flex-1 py-1"
        />
        <span className="w-10 text-left text-xs tabular-nums text-muted-foreground">{formatDurationDetailed(duration || 0)}</span>
      </div>
    </div>
  );
}
