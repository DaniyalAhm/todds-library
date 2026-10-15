'use client';

import { useEffect, useRef, useState } from 'react';
import { useBook, useGenerateChapterSubtitles, useGenerateChapters } from '@/hooks/use-books';
import { useAuth } from '@/hooks/use-auth';
import { cn, formatDurationDetailed } from '@/lib/utils';
import { usePlayer } from '@/hooks/use-player';
import { useAudioPlayer } from './audio-player-context';
import { ChapterList } from './chapter-list';
import { SleepTimer } from './sleep-timer';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { Captions, CaptionsOff, Headphones, ListTree, Maximize, Minimize, PanelTop, Pause, Play, RefreshCw, SkipBack, SkipForward } from 'lucide-react';
import { SubtitleOverlay, loadSubtitleFile } from '@/components/reader/subtitle-overlay';
import type { SubtitleCue } from '@/components/reader/subtitle-overlay';
import { logger } from '@/lib/logger';
import {
  exitDocumentFullscreen,
  getFullscreenElement,
  isFullscreenApiEnabled,
  isStandaloneDisplayMode,
  requestElementFullscreen,
  shouldUseCssFullscreenFallback,
} from '@/lib/fullscreen';

interface AudiobookPlayerProps {
  bookId: string;
}

export function AudiobookPlayer({ bookId }: AudiobookPlayerProps) {
  const { user } = useAuth();
  const { data: book } = useBook(bookId);
  const generateChapterSubtitles = useGenerateChapterSubtitles(bookId);
  const generateChapters = useGenerateChapters(bookId);

  const audio = useAudioPlayer();
  const {
    currentTime,
    duration,
    volume,
    speed,
    chapterIndex,
    chapters,
    sleepTimerEnd,
    isPlaying,
    setVolume,
    setSpeed,
    setSleepTimer,
    clearSleepTimer,
    setCurrentBook,
    setCurrentBookInfo,
  } = usePlayer();

  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [subtitleMode, setSubtitleMode] = useState<'panel' | 'overlay'>('panel');
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isCssFullscreen, setIsCssFullscreen] = useState(false);
  const [showFullscreenControls, setShowFullscreenControls] = useState(true);
  const fullscreenControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isVisualFullscreen = isFullscreen || isCssFullscreen;

  // Ensure global player knows which book is active (persists across navigation)
  useEffect(() => {
    if (book) {
      setCurrentBook(bookId, {
        id: book.id,
        title: book.title,
        author: book.author ?? null,
        cover: book.cover ?? null,
      });
    } else {
      setCurrentBook(bookId);
    }
    // Do NOT clear on unmount — keeps playback alive when navigating away
  }, [bookId, book, setCurrentBook]);

  // Keep currentBookInfo fresh when book metadata loads
  useEffect(() => {
    if (book && bookId) {
      setCurrentBookInfo({
        id: book.id,
        title: book.title,
        author: book.author ?? null,
        cover: book.cover ?? null,
      });
    }
  }, [book, bookId, setCurrentBookInfo]);

  useEffect(() => {
    const currentChapter = chapters[chapterIndex];
    let cancelled = false;
    setCues([]);
    if (currentChapter?.id) {
      loadSubtitleFile(bookId, currentChapter.id)
        .then((loadedCues) => {
          if (!cancelled) setCues(normalizeCuesToPlaybackTimeline(loadedCues, currentChapter, audio.isMultiTrackDirect));
        })
        .catch(() => { if (!cancelled) setCues([]); });
    }
    return () => { cancelled = true; };
  }, [chapterIndex, chapters, bookId, audio.isMultiTrackDirect]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const el = getFullscreenElement();
      const nowFullscreen = !!el;
      setIsFullscreen(nowFullscreen);
      if (nowFullscreen) setIsCssFullscreen(false);
      if (nowFullscreen) {
        setShowFullscreenControls(true);
        if (fullscreenControlsTimerRef.current) clearTimeout(fullscreenControlsTimerRef.current);
        fullscreenControlsTimerRef.current = setTimeout(() => setShowFullscreenControls(false), 3000);
      } else {
        setShowFullscreenControls(true);
        if (fullscreenControlsTimerRef.current) {
          clearTimeout(fullscreenControlsTimerRef.current);
          fullscreenControlsTimerRef.current = null;
        }
      }
    };
    const onFullscreenError = (e: Event) => {
      const detail = (e as any)?.message || (e as any)?.target?.toString() || 'fullscreenerror event';
      logger.fs.warn('fullscreenerror event:', detail, 'enabled:', document.fullscreenEnabled, 'secure:', window.isSecureContext, 'protocol:', location.protocol);
      if (!shouldUseCssFullscreenFallback()) {
        toast({ title: 'Fullscreen failed', description: 'Browser blocked fullscreen (check secure context / permissions)', variant: 'destructive' });
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange as any);
    document.addEventListener('fullscreenerror', onFullscreenError as any);
    document.addEventListener('webkitfullscreenerror', onFullscreenError as any);
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', onFullscreenChange as any);
      document.removeEventListener('fullscreenerror', onFullscreenError as any);
      document.removeEventListener('webkitfullscreenerror', onFullscreenError as any);
      if (fullscreenControlsTimerRef.current) {
        clearTimeout(fullscreenControlsTimerRef.current);
        fullscreenControlsTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!isCssFullscreen) return;
    const previousBodyOverflow = document.body.style.overflow;
    const previousHtmlOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousBodyOverflow;
      document.documentElement.style.overflow = previousHtmlOverflow;
    };
  }, [isCssFullscreen]);

  const enterCssFullscreen = (source: string) => {
    logger.fs.info(`${source}: entering CSS fullscreen fallback`);
    setIsCssFullscreen(true);
    setShowFullscreenControls(true);
    if (fullscreenControlsTimerRef.current) clearTimeout(fullscreenControlsTimerRef.current);
    fullscreenControlsTimerRef.current = setTimeout(() => setShowFullscreenControls(false), 3000);
  };

  const toggleFullscreen = async () => {
    try {
      const fsEl = getFullscreenElement();
      if (fsEl || isCssFullscreen) {
        if (fsEl) await exitDocumentFullscreen();
        setIsCssFullscreen(false);
        setIsFullscreen(false);
        setShowFullscreenControls(true);
        if (fullscreenControlsTimerRef.current) {
          clearTimeout(fullscreenControlsTimerRef.current);
          fullscreenControlsTimerRef.current = null;
        }
        return;
      }
      if (!isFullscreenApiEnabled()) {
        if (shouldUseCssFullscreenFallback()) {
          enterCssFullscreen('Fullscreen API unavailable');
          return;
        }
        logger.fs.warn('Fullscreen not supported / blocked (secure:', window.isSecureContext, 'protocol:', location.protocol, 'isSecureContext:', window.isSecureContext, ')');
        toast({ title: 'Fullscreen not supported', description: 'This browser or context blocks fullscreen', variant: 'destructive' });
        return;
      }
      // Pre-flight: log secure context for docker diagnostics
      if (!window.isSecureContext && !isStandaloneDisplayMode()) {
        logger.fs.warn('Insecure context pre-flight: protocol', location.protocol, 'isSecureContext', window.isSecureContext, 'fullscreenEnabled', document.fullscreenEnabled);
      }
      const el = containerRef.current;
      if (!el) return;
      // Debounce rapid double-click: ignore if already pending (element has pending request)
      if ((el as any)._fsPending) return;
      (el as any)._fsPending = true;
      try {
        await requestElementFullscreen(el);
        logger.fs.info('requestFullscreen succeeded (secure:', window.isSecureContext, 'protocol:', location.protocol, ')');
      } finally {
        setTimeout(() => {
          if (el) (el as any)._fsPending = false;
        }, 500);
      }
    } catch (err: any) {
      const detail =
        err instanceof Error || (typeof DOMException !== 'undefined' && err instanceof DOMException)
          ? `${err.name}: ${err.message}${(err as any).code ? ` code:${(err as any).code}` : ''}${(err as any).stack ? `\n${(err as any).stack}` : ''} secure:${window.isSecureContext} protocol:${location.protocol} hasEl:${!!containerRef.current} enabled:${document.fullscreenEnabled}`
          : String(err);
      logger.fs.warn('Fullscreen toggle failed:', detail);
      if (shouldUseCssFullscreenFallback()) {
        enterCssFullscreen('Fullscreen request failed');
        return;
      }
      toast({ title: 'Fullscreen failed', description: err?.message || detail, variant: 'destructive' });
    }
  };

  const startControlsTimer = () => {
    if (fullscreenControlsTimerRef.current) clearTimeout(fullscreenControlsTimerRef.current);
    fullscreenControlsTimerRef.current = setTimeout(() => setShowFullscreenControls(false), 3000);
  };

  const handleFullscreenMouseMove = () => {
    setShowFullscreenControls(true);
    startControlsTimer();
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const sleepRemaining = sleepTimerEnd ? Math.ceil((sleepTimerEnd - Date.now()) / 60000) : undefined;
  const currentChapter = chapters[chapterIndex];
  const subtitleTime = currentTime;

  const selectChapter = (idx: number) => {
    audio.selectChapter(idx);
  };

  const handleGenerateSubtitles = async () => {
    const chapter = chapters[chapterIndex];
    if (!chapter?.id) return;
    try {
      await generateChapterSubtitles.mutateAsync({ chapterId: chapter.id });
      const nextCues = await loadSubtitleFile(bookId, chapter.id);
      setCues(normalizeCuesToPlaybackTimeline(nextCues, chapter, audio.isMultiTrackDirect));
      toast({ title: 'Subtitles generated', description: nextCues.length > 0 ? 'Captions are ready for this chapter.' : 'Subtitle files were created for this chapter.', variant: 'success' });
    } catch (error) {
      const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message) : 'Speech recognition failed for this chapter.';
      toast({ title: 'Subtitle generation failed', description: message, variant: 'destructive' });
    }
  };

  const handleGenerateChapters = async () => {
    try {
      const res = await generateChapters.mutateAsync({ overwrite: true });
      toast({ title: 'Chapters generated', description: `Detected ${res.chapter_count} chapters from whisper timestamps.`, variant: 'success' });
    } catch (error) {
      const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message) : 'Chapter detection failed.';
      toast({ title: 'Chapter generation failed', description: message, variant: 'destructive' });
    }
  };

  const handleForceRegenerateSubtitles = async () => {
    const chapter = chapters[chapterIndex];
    if (!chapter?.id) return;
    try {
      await generateChapterSubtitles.mutateAsync({ chapterId: chapter.id, overwrite: true });
      const nextCues = await loadSubtitleFile(bookId, chapter.id);
      setCues(normalizeCuesToPlaybackTimeline(nextCues, chapter, audio.isMultiTrackDirect));
      toast({ title: 'Subtitles regenerated', description: nextCues.length > 0 ? 'Captions were regenerated for this chapter.' : 'Subtitle files were regenerated for this chapter.', variant: 'success' });
    } catch (error) {
      const message = typeof error === 'object' && error !== null && 'message' in error ? String((error as { message?: unknown }).message) : 'Speech recognition failed for this chapter.';
      toast({ title: 'Subtitle regeneration failed', description: message, variant: 'destructive' });
    }
  };

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row', isVisualFullscreen && 'hidden')}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto px-4 py-3 sm:p-6 lg:justify-center lg:p-8">
          <div className="mb-3 shrink-0 sm:mb-8">
            <div className="relative mx-auto aspect-[2/3] w-28 overflow-hidden rounded-xl bg-muted shadow-2xl sm:w-48 md:w-56 lg:w-64">
              {book?.cover ? (
                <img src={book.cover} alt={book?.title} className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Headphones className="h-16 w-16 text-muted-foreground/50" />
                </div>
              )}
            </div>
          </div>

          <div className="mb-3 min-w-0 max-w-full text-center sm:mb-2">
            <h2 className="line-clamp-2 text-lg font-bold text-foreground sm:text-xl">{book?.title}</h2>
            {book?.author && <p className="text-sm text-muted-foreground">{book.author}</p>}
          </div>

          <div className="w-full max-w-lg min-w-0">
            {audio.loadError && <p className="mb-3 text-sm text-destructive">{audio.loadError}</p>}
            {captionsEnabled && subtitleMode === 'panel' && (
              <SubtitleOverlay currentTime={subtitleTime} cues={cues} mode="panel" className="mb-3" />
            )}

            {/* Custom transport — drives global PlayerHost */}
            <div className="relative rounded-lg border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">{formatDurationDetailed(currentTime)}</span>
                <Slider
                  value={[currentTime]}
                  max={duration || 100}
                  step={1}
                  onValueChange={([v]) => audio.seek(v)}
                  className="flex-1"
                />
                <span className="w-12 text-left text-xs tabular-nums text-muted-foreground">-{formatDurationDetailed(Math.max(0, (duration || 0) - currentTime))}</span>
              </div>

              <div className="mt-3 flex items-center justify-center gap-2">
                <Button variant="ghost" size="icon" onClick={audio.prevChapter} aria-label="Previous chapter">
                  <SkipBack className="h-5 w-5" />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => audio.seekRelative(-10)} aria-label="Back 10s">
                  <span className="text-xs font-mono">-10</span>
                </Button>
                <Button variant="secondary" size="icon" className="h-12 w-12 rounded-full" onClick={audio.toggle} aria-label={isPlaying ? 'Pause' : 'Play'}>
                  {isPlaying ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6 pl-0.5" />}
                </Button>
                <Button variant="ghost" size="icon" onClick={() => audio.seekRelative(10)} aria-label="Forward 10s">
                  <span className="text-xs font-mono">+10</span>
                </Button>
                <Button variant="ghost" size="icon" onClick={audio.nextChapter} aria-label="Next chapter">
                  <SkipForward className="h-5 w-5" />
                </Button>
              </div>

              <div className="mt-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Vol</span>
                  <Slider
                    value={[volume * 100]}
                    max={100}
                    step={1}
                    onValueChange={([v]) => setVolume(v / 100)}
                    className="w-20"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">Speed</span>
                  <select
                    value={speed}
                    onChange={(e) => setSpeed(parseFloat(e.target.value))}
                    className="rounded border border-border bg-background px-2 py-1 text-xs"
                  >
                    {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((s) => (
                      <option key={s} value={s}>
                        {s}x
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {captionsEnabled && subtitleMode === 'overlay' && (
                <div className="mt-3">
                  <SubtitleOverlay currentTime={subtitleTime} cues={cues} mode="overlay" />
                </div>
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-4">
              <Button type="button" variant="outline" size="sm" onClick={handleGenerateSubtitles} disabled={!currentChapter?.id || generateChapterSubtitles.isPending} className="min-w-0 justify-center px-2">
                <Captions className="mr-2 h-4 w-4" />
                <span className="truncate">{generateChapterSubtitles.isPending ? 'Generating...' : 'Generate Subtitles'}</span>
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={handleGenerateChapters} disabled={generateChapters.isPending} className="min-w-0 justify-center px-2">
                <ListTree className="mr-2 h-4 w-4" />
                <span className="truncate">{generateChapters.isPending ? 'Detecting...' : 'Generate Chapters'}</span>
              </Button>
              {user?.isAdmin && (
                <Button type="button" variant="outline" size="sm" onClick={handleForceRegenerateSubtitles} disabled={!currentChapter?.id || generateChapterSubtitles.isPending} className="min-w-0 justify-center px-2">
                  <RefreshCw className="mr-2 h-4 w-4" />
                  <span className="truncate">{generateChapterSubtitles.isPending ? 'Regenerating...' : 'Force Regenerate'}</span>
                </Button>
              )}
              <Button type="button" variant={captionsEnabled ? 'secondary' : 'outline'} size="sm" onClick={() => setCaptionsEnabled((v) => !v)} className="justify-center px-2">
                {captionsEnabled ? <Captions className="mr-2 h-4 w-4" /> : <CaptionsOff className="mr-2 h-4 w-4" />}
                Captions
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={() => setSubtitleMode((m) => (m === 'panel' ? 'overlay' : 'panel'))} disabled={!captionsEnabled} className="justify-center px-2">
                <PanelTop className="mr-2 h-4 w-4" />
                {subtitleMode === 'panel' ? 'Panel' : 'Overlay'}
              </Button>
              <Button type="button" variant="outline" size="sm" onClick={toggleFullscreen} className="justify-center px-2">
                {isVisualFullscreen ? <Minimize className="mr-2 h-4 w-4" /> : <Maximize className="mr-2 h-4 w-4" />}
                {isVisualFullscreen ? 'Exit' : 'Fullscreen'}
              </Button>
              <SleepTimer
                isActive={!!sleepTimerEnd}
                remainingMinutes={sleepRemaining}
                onSetTimer={(m) => setSleepTimer(m === -1 ? 9999 : m)}
                onClearTimer={clearSleepTimer}
                className="justify-self-center sm:justify-self-auto"
              />
            </div>
          </div>
        </div>

        <div className="min-h-0 h-[min(36dvh,18rem)] shrink-0 border-t border-border bg-card sm:h-[min(42dvh,24rem)] lg:h-auto lg:w-96 lg:border-l lg:border-t-0">
          <ChapterList chapters={chapters} currentChapterIndex={chapterIndex} onSelectChapter={selectChapter} className="h-full" />
        </div>
      </div>

      {isVisualFullscreen && (
        <div
          className={cn('relative flex flex-1 flex-col bg-black', isCssFullscreen && 'fixed inset-0 z-[100] h-[100dvh] w-screen')}
          style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' } as React.CSSProperties}
          onMouseMove={handleFullscreenMouseMove}
          onMouseEnter={() => setShowFullscreenControls(true)}
          onTouchStart={handleFullscreenMouseMove}
          onTouchMove={handleFullscreenMouseMove}
        >
          {book?.cover && (
            <>
              <img src={book.cover} alt="" className="absolute inset-0 h-full w-full object-cover blur-2xl opacity-30" />
              <div className="absolute inset-0 bg-black/50" />
            </>
          )}
          <div className="relative flex flex-1 items-center justify-center">
            {captionsEnabled ? <SubtitleOverlay currentTime={subtitleTime} cues={cues} mode="fullscreen" /> : <p className="text-center text-xl text-white/50">Captions disabled</p>}
          </div>
          <div className={cn('relative transition-opacity duration-300', showFullscreenControls ? 'opacity-100' : 'opacity-0 pointer-events-none')}>
            <div className="flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-4 pb-6 pt-12">
              <div className="flex items-center gap-3">
                <button type="button" onClick={audio.prevChapter} className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white">
                  <SkipBack className="h-5 w-5" />
                </button>
                <button type="button" onClick={() => audio.seekRelative(-10)} className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white">
                  <span className="text-xs font-mono">-10</span>
                </button>
                <button type="button" onClick={audio.toggle} className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30">
                  {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                </button>
                <button type="button" onClick={() => audio.seekRelative(10)} className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white">
                  <span className="text-xs font-mono">+10</span>
                </button>
                <button type="button" onClick={audio.nextChapter} className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white">
                  <SkipForward className="h-5 w-5" />
                </button>
                <span className="ml-2 text-sm text-white/70">
                  {formatTime(currentTime)} / {formatTime(duration || 0)}
                </span>
              </div>
              <button type="button" onClick={toggleFullscreen} className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white">
                <Minimize className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeCuesToPlaybackTimeline(
  cues: SubtitleCue[],
  chapter: { start: number; end: number },
  isMultiTrack: boolean
): SubtitleCue[] {
  if (cues.length === 0 || chapter.start <= 0 || !isMultiTrack) return cues;
  return cues.map((cue) => ({
    ...cue,
    start: cue.start + chapter.start,
    end: cue.end + chapter.start,
    words: cue.words?.map((word) => ({ ...word, start: word.start + chapter.start, end: word.end + chapter.start })),
  }));
}
