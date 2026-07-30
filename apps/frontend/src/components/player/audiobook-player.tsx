'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import AudioPlayer from 'react-h5-audio-player';
import { useBook, useBookProgress, useGenerateChapterSubtitles, useUpdateProgress } from '@/hooks/use-books';
import { cn } from '@/lib/utils';
import { usePlayer } from '@/hooks/use-player';
import { ChapterList } from './chapter-list';
import { SleepTimer } from './sleep-timer';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast';
import { Captions, CaptionsOff, Headphones, Maximize, Minimize, PanelTop, Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { SubtitleOverlay, loadSubtitleFile } from '@/components/reader/subtitle-overlay';
import type { SubtitleCue } from '@/components/reader/subtitle-overlay';

interface AudiobookPlayerProps {
  bookId: string;
}

export function AudiobookPlayer({ bookId }: AudiobookPlayerProps) {
  const { data: book } = useBook(bookId);
  const { data: progress } = useBookProgress(bookId);
  const updateProgress = useUpdateProgress(bookId);
  const generateChapterSubtitles = useGenerateChapterSubtitles(bookId);
  const playerRef = useRef<AudioPlayer>(null);
  const hlsRef = useRef<any>(null);
  const [audioSrc, setAudioSrc] = useState('');
  const [loadError, setLoadError] = useState('');
  const [triedHls, setTriedHls] = useState(false);
  const [trackIndex, setTrackIndex] = useState(0);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const [captionsEnabled, setCaptionsEnabled] = useState(true);
  const [subtitleMode, setSubtitleMode] = useState<'panel' | 'overlay'>('panel');
  const hydratedProgressBookRef = useRef<string | null>(null);
  const seekAfterTrackLoadRef = useRef<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showFullscreenControls, setShowFullscreenControls] = useState(true);
  const fullscreenControlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playbackTimeFrameRef = useRef<number | null>(null);

  const {
    currentTime,
    duration,
    volume,
    speed,
    chapterIndex,
    chapters,
    sleepTimerEnd,
    isPlaying,
    play,
    pause,
    togglePlay,
    seek,
    setVolume,
    setSpeed,
    setSleepTimer,
    clearSleepTimer,
    setCurrentBook,
    setDuration,
    setCurrentTime,
    setChapters,
    setChapterIndex,
  } = usePlayer();

  useEffect(() => {
    setCurrentBook(bookId);
    hydratedProgressBookRef.current = null;
    return () => {
      setCurrentBook(null);
      setCurrentTime(0);
      setDuration(0);
    };
  }, [bookId, setCurrentBook, setCurrentTime, setDuration]);

  useEffect(() => {
    if (book?.chapters) {
      const chapterList = book.chapters.map((ch: any, idx: number) => ({
        id: ch.id || String(idx),
        title: ch.title || `Chapter ${idx + 1}`,
        start: ch.start_position || 0,
        end: ch.end_position ?? 0,
      }));
      const totalDuration = book.duration || 0;
      for (let i = 0; i < chapterList.length; i++) {
        if (chapterList[i].end === 0) {
          const nextStart = chapterList[i + 1]?.start ?? totalDuration;
          chapterList[i].end = nextStart;
        }
      }
      setChapters(chapterList);
    }
    if (book?.duration && (book.audio_track_count || 0) > 1) {
      setDuration(book.duration);
    }
  }, [book, setChapters, setDuration]);

  const trackStart = useCallback((index: number) => chapters[index]?.start || 0, [chapters]);

  const trackDuration = useCallback(
    (index: number) => {
      const start = trackStart(index);
      const nextStart = chapters[index + 1]?.start;
      if (typeof nextStart === 'number' && nextStart > start) {
        return nextStart - start;
      }
      return Math.max(0, (duration || 0) - start);
    },
    [chapters, duration, trackStart]
  );

  const trackForPosition = useCallback(
    (position: number) => {
      if (chapters.length === 0) return 0;
      const index = chapters.findIndex(
        (chapter, idx) => position >= chapter.start && position < (chapters[idx + 1]?.start ?? Number.POSITIVE_INFINITY)
      );
      return Math.max(0, index);
    },
    [chapters]
  );

  const audioUrlForTrack = useCallback(
    (index: number) => {
      if (!book?.audio_download_url) return '';
      const url = new URL(book.audio_download_url);
      url.searchParams.set('track', String(index));
      return url.toString();
    },
    [book?.audio_download_url]
  );

  const isMultiTrackDirect = (book?.audio_track_count || 0) > 1;

  useEffect(() => {
    if (progress && chapters.length > 0 && isMultiTrackDirect && hydratedProgressBookRef.current !== bookId) {
      hydratedProgressBookRef.current = bookId;
      const position = progress.position || 0;
      const nextTrackIndex = trackForPosition(position);
      setTrackIndex(nextTrackIndex);
      seek(position);
      seekAfterTrackLoadRef.current = Math.max(0, position - trackStart(nextTrackIndex));
    }
  }, [bookId, chapters.length, isMultiTrackDirect, progress, seek, trackForPosition, trackStart]);

  const setupDirectAudio = useCallback(() => {
    if (!book?.audio_download_url) {
      setLoadError('Audio file is not available.');
      return;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setAudioSrc(audioUrlForTrack(trackIndex));
  }, [audioUrlForTrack, book?.audio_download_url, trackIndex]);

  const setupHlsStream = useCallback(async (force = false) => {
    if (!book?.stream_url || (!force && triedHls) || isMultiTrackDirect) {
      setupDirectAudio();
      return;
    }

    const audio = playerRef.current?.audio.current;
    if (!audio) {
      setupDirectAudio();
      return;
    }

    setTriedHls(true);
    setLoadError('');

    try {
      const Hls = (await import('hls.js')).default;

      if (Hls.isSupported()) {
        if (hlsRef.current) {
          hlsRef.current.destroy();
        }
        hlsRef.current = new Hls();
        setAudioSrc('');
        hlsRef.current.loadSource(book.stream_url);
        hlsRef.current.attachMedia(audio);
        hlsRef.current.on(Hls.Events.MANIFEST_PARSED, () => {
          setDuration(audio.duration || 0);
          audio.play().catch(() => undefined);
        });
        hlsRef.current.on(Hls.Events.ERROR, (_event: unknown, data: any) => {
          if (data?.fatal) {
            setupDirectAudio();
          }
        });
        return;
      }

      if (audio.canPlayType('application/vnd.apple.mpegurl')) {
        setAudioSrc(book.stream_url);
        return;
      }
    } catch (err) {
      console.error('Failed to start HLS stream:', err);
    }

    setupDirectAudio();
  }, [book?.stream_url, isMultiTrackDirect, setDuration, setupDirectAudio, triedHls]);

  const setupAudio = useCallback(async () => {
    if (!book) return;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setLoadError('');
    setAudioSrc('');
    if (isMultiTrackDirect) {
      setupDirectAudio();
      return;
    }
    await setupHlsStream(true);
  }, [book, isMultiTrackDirect, setupDirectAudio, setupHlsStream]);

  useEffect(() => {
    setupAudio();
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [setupAudio]);

  const syncCurrentTimeFromAudio = useCallback(() => {
    const audio = playerRef.current?.audio.current;
    if (!audio) return;
    const globalTime = isMultiTrackDirect ? trackStart(trackIndex) + audio.currentTime : audio.currentTime;
    setCurrentTime(globalTime);
  }, [isMultiTrackDirect, setCurrentTime, trackIndex, trackStart]);

  useEffect(() => {
    const audio = playerRef.current?.audio.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      syncCurrentTimeFromAudio();
    };
    const onDurationChange = () => {
      if (!isMultiTrackDirect) {
        setDuration(audio.duration);
      }
    };

    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);

    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
    };
  }, [setDuration, audioSrc, isMultiTrackDirect, syncCurrentTimeFromAudio]);

  useEffect(() => {
    if (!isPlaying) {
      if (playbackTimeFrameRef.current !== null) {
        cancelAnimationFrame(playbackTimeFrameRef.current);
        playbackTimeFrameRef.current = null;
      }
      syncCurrentTimeFromAudio();
      return;
    }

    const tick = () => {
      const audio = playerRef.current?.audio.current;
      if (audio && !audio.paused) {
        const globalTime = isMultiTrackDirect ? trackStart(trackIndex) + audio.currentTime : audio.currentTime;
        setCurrentTime(globalTime);
      }
      playbackTimeFrameRef.current = requestAnimationFrame(tick);
    };

    playbackTimeFrameRef.current = requestAnimationFrame(tick);

    return () => {
      if (playbackTimeFrameRef.current !== null) {
        cancelAnimationFrame(playbackTimeFrameRef.current);
        playbackTimeFrameRef.current = null;
      }
    };
  }, [isPlaying, isMultiTrackDirect, setCurrentTime, syncCurrentTimeFromAudio, trackIndex, trackStart]);

  useEffect(() => {
    const audio = playerRef.current?.audio.current;
    if (audio) audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = playerRef.current?.audio.current;
    if (audio) audio.playbackRate = speed;
  }, [speed]);

  useEffect(() => {
    const audio = playerRef.current?.audio.current;
    if (!audio || seekAfterTrackLoadRef.current === null) return;
    const nextTime = seekAfterTrackLoadRef.current;
    seekAfterTrackLoadRef.current = null;
    audio.currentTime = nextTime;
  }, [audioSrc]);

  useEffect(() => {
    if (chapters.length > 0 && currentTime >= 0) {
      const idx = chapters.findIndex(
        (ch, index) => currentTime >= ch.start && currentTime < (ch.end || chapters[index + 1]?.start || duration || Number.POSITIVE_INFINITY)
      );
      if (idx >= 0 && idx !== chapterIndex) {
        setChapterIndex(idx);
      }
    }
  }, [currentTime, chapters, chapterIndex, duration, setChapterIndex]);

  useEffect(() => {
    const currentChapter = chapters[chapterIndex];
    if (currentChapter?.id) {
      setCues([]);
      loadSubtitleFile(bookId, currentChapter.id)
        .then((loadedCues) => setCues(normalizeCuesToPlaybackTimeline(loadedCues, currentChapter)))
        .catch(() => setCues([]));
    }
  }, [chapterIndex, chapters, bookId]);

  useEffect(() => {
    const onFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      containerRef.current?.requestFullscreen();
    }
  };

  const startControlsTimer = useCallback(() => {
    if (fullscreenControlsTimerRef.current) {
      clearTimeout(fullscreenControlsTimerRef.current);
    }
    fullscreenControlsTimerRef.current = setTimeout(() => {
      setShowFullscreenControls(false);
    }, 3000);
  }, []);

  const handleFullscreenMouseMove = useCallback(() => {
    setShowFullscreenControls(true);
    startControlsTimer();
  }, [startControlsTimer]);

  const handleSeekRelative = useCallback(
    (delta: number) => {
      let audio: HTMLAudioElement | null = null;
      if (isMultiTrackDirect) {
        const el = playerRef.current?.audio.current;
        if (el) audio = el;
      } else {
        audio = playerRef.current?.audio.current ?? null;
      }
      if (!audio) return;
      const newTime = Math.max(0, Math.min(audio.duration || 0, audio.currentTime + delta));
      audio.currentTime = newTime;
    },
    [isMultiTrackDirect]
  );

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  const saveProgress = useCallback(() => {
    const audio = playerRef.current?.audio.current;
    if (!audio || !bookId) return;
    const globalPosition = isMultiTrackDirect ? trackStart(trackIndex) + audio.currentTime : audio.currentTime;
    const totalDuration = duration || audio.duration || 1;
    updateProgress.mutate({
      progress: globalPosition / totalDuration,
      position: globalPosition,
    });

    if (sleepTimerEnd && Date.now() >= sleepTimerEnd) {
      audio.pause();
      clearSleepTimer();
    }
  }, [bookId, clearSleepTimer, duration, isMultiTrackDirect, sleepTimerEnd, trackIndex, trackStart, updateProgress]);

  const handleSeek = (time: number) => {
    seek(time);
    if (isMultiTrackDirect) {
      const nextTrackIndex = trackForPosition(time);
      const localTime = Math.max(0, time - trackStart(nextTrackIndex));
      if (nextTrackIndex !== trackIndex) {
        seekAfterTrackLoadRef.current = localTime;
        setTrackIndex(nextTrackIndex);
        setAudioSrc(audioUrlForTrack(nextTrackIndex));
        return;
      }
      const audio = playerRef.current?.audio.current;
      if (audio) {
        audio.currentTime = localTime;
      }
      return;
    }
    const audio = playerRef.current?.audio.current;
    if (audio) {
      audio.currentTime = time;
    }
  };

  const handleNativeAudioSeek = (localTime: number) => {
    if (isMultiTrackDirect) {
      seek(trackStart(trackIndex) + localTime);
      return;
    }
    seek(localTime);
  };

  const handlePreviousChapter = () => {
    const previousIndex = currentTime - (chapters[chapterIndex]?.start || 0) > 5
      ? chapterIndex
      : Math.max(0, chapterIndex - 1);
    setChapterIndex(previousIndex);
    handleSeek(chapters[previousIndex]?.start || 0);
  };

  const handleNextChapter = () => {
    const nextIndex = Math.min(chapters.length - 1, chapterIndex + 1);
    setChapterIndex(nextIndex);
    handleSeek(chapters[nextIndex]?.start || duration);
  };

  const handleTrackEnded = () => {
    saveProgress();
    if (isMultiTrackDirect && trackIndex < (book?.audio_track_count || 1) - 1) {
      const nextIndex = trackIndex + 1;
      setTrackIndex(nextIndex);
      setChapterIndex(nextIndex);
      seekAfterTrackLoadRef.current = 0;
      setAudioSrc(audioUrlForTrack(nextIndex));
      return;
    }
    if (chapterIndex < chapters.length - 1) {
      handleNextChapter();
    } else {
      pause();
    }
  };

  const handleGenerateSubtitles = async () => {
    const currentChapter = chapters[chapterIndex];
    if (!currentChapter?.id) return;

    try {
      await generateChapterSubtitles.mutateAsync({ chapterId: currentChapter.id });
      const nextCues = await loadSubtitleFile(bookId, currentChapter.id);
      setCues(normalizeCuesToPlaybackTimeline(nextCues, currentChapter));
      toast({
        title: 'Subtitles generated',
        description: nextCues.length > 0
          ? 'Captions are ready for this chapter.'
          : 'Subtitle files were created for this chapter.',
        variant: 'success',
      });
    } catch (error) {
      const message =
        typeof error === 'object' && error !== null && 'message' in error
          ? String((error as { message?: unknown }).message)
          : 'Speech recognition failed for this chapter.';
      toast({
        title: 'Subtitle generation failed',
        description: message,
        variant: 'destructive',
      });
    }
  };

  const sleepRemaining = sleepTimerEnd
    ? Math.ceil((sleepTimerEnd - Date.now()) / 60000)
    : undefined;
  const currentChapter = chapters[chapterIndex];
  const subtitleTime = currentTime;

  const selectChapter = (idx: number) => {
    setChapterIndex(idx);
    handleSeek(chapters[idx]?.start || 0);
  };

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <div className={cn('flex min-h-0 flex-1 flex-col overflow-hidden lg:flex-row', isFullscreen && 'hidden')}>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center overflow-y-auto px-4 py-3 sm:p-6 lg:justify-center lg:p-8">
          <div className="mb-3 shrink-0 sm:mb-8">
            <div className="relative mx-auto aspect-[2/3] w-28 overflow-hidden rounded-xl bg-muted shadow-2xl sm:w-48 md:w-56 lg:w-64">
              {book?.cover ? (
                <img
                  src={book.cover}
                  alt={book?.title}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full w-full items-center justify-center">
                  <Headphones className="h-16 w-16 text-muted-foreground/50" />
                </div>
              )}
            </div>
          </div>

          <div className="mb-3 min-w-0 max-w-full text-center sm:mb-2">
            <h2 className="line-clamp-2 text-lg font-bold text-foreground sm:text-xl">{book?.title}</h2>
            {book?.author && (
              <p className="text-sm text-muted-foreground">{book.author}</p>
            )}
          </div>

          <div className="w-full max-w-lg min-w-0">
            {loadError && (
              <p className="mb-3 text-sm text-destructive">{loadError}</p>
            )}
            {captionsEnabled && subtitleMode === 'panel' && (
              <SubtitleOverlay
                currentTime={subtitleTime}
                cues={cues}
                mode="panel"
                className="mb-3"
              />
            )}
            <div className="relative">
              <AudioPlayer
                ref={playerRef}
                className="tl-audiobook-player"
                src={audioSrc}
                preload="metadata"
                showSkipControls
                showJumpControls
                progressJumpSteps={{ backward: 10000, forward: 10000 }}
                volume={volume}
                listenInterval={30000}
                onListen={saveProgress}
                onPause={pause}
                onPlay={play}
                onEnded={handleTrackEnded}
                onClickPrevious={handlePreviousChapter}
                onClickNext={handleNextChapter}
                onSeeking={(event) => {
                  const audio = event.currentTarget as HTMLAudioElement;
                  handleNativeAudioSeek(audio.currentTime);
                }}
                onLoadedMetaData={(event) => {
                  const audio = event.currentTarget as HTMLAudioElement;
                  if (!isMultiTrackDirect) {
                    setDuration(audio.duration || 0);
                  }
                  if (seekAfterTrackLoadRef.current !== null) {
                    audio.currentTime = seekAfterTrackLoadRef.current;
                    seekAfterTrackLoadRef.current = null;
                  }
                }}
                onError={(event) => {
                  const audio = event.currentTarget as HTMLAudioElement;
                  const currentSrc = audio.currentSrc || audioSrc;

                  if (!currentSrc || (hlsRef.current && !audioSrc)) {
                    return;
                  }

                  if (book?.audio_download_url && currentSrc === book.stream_url) {
                    setupDirectAudio();
                  } else if (!triedHls) {
                    void setupHlsStream();
                  } else {
                    setLoadError('Audio failed to load.');
                  }
                }}
              />
              {captionsEnabled && subtitleMode === 'overlay' && (
                <SubtitleOverlay currentTime={subtitleTime} cues={cues} mode="overlay" />
              )}
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleGenerateSubtitles}
                disabled={!currentChapter?.id || generateChapterSubtitles.isPending}
                className="min-w-0 justify-center px-2"
              >
                <Captions className="mr-2 h-4 w-4" />
                <span className="truncate">
                  {generateChapterSubtitles.isPending ? 'Generating...' : 'Generate Subtitles'}
                </span>
              </Button>

              <Button
                type="button"
                variant={captionsEnabled ? 'secondary' : 'outline'}
                size="sm"
                onClick={() => setCaptionsEnabled((enabled) => !enabled)}
                className="justify-center px-2"
              >
                {captionsEnabled ? (
                  <Captions className="mr-2 h-4 w-4" />
                ) : (
                  <CaptionsOff className="mr-2 h-4 w-4" />
                )}
                Captions
              </Button>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setSubtitleMode((mode) => mode === 'panel' ? 'overlay' : 'panel')}
                disabled={!captionsEnabled}
                className="justify-center px-2"
              >
                <PanelTop className="mr-2 h-4 w-4" />
                {subtitleMode === 'panel' ? 'Panel' : 'Overlay'}
              </Button>

              <div className="flex items-center justify-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 sm:border-0 sm:bg-transparent sm:p-0">
                <span className="text-xs text-muted-foreground">Speed:</span>
                <select
                  value={speed}
                  onChange={(e) => setSpeed(parseFloat(e.target.value))}
                  className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground"
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((s) => (
                    <option key={s} value={s}>
                      {s}x
                    </option>
                  ))}
                </select>
              </div>

              <div className="hidden items-center justify-center gap-2 sm:flex">
                <span className="text-xs text-muted-foreground">Vol:</span>
                <Slider
                  value={[volume * 100]}
                  max={100}
                  step={1}
                  onValueChange={([v]) => setVolume(v / 100)}
                  className="w-28 sm:w-20"
                />
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={toggleFullscreen}
                className="justify-center px-2"
              >
                {isFullscreen ? <Minimize className="mr-2 h-4 w-4" /> : <Maximize className="mr-2 h-4 w-4" />}
                {isFullscreen ? 'Exit' : 'Fullscreen'}
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
          <ChapterList
            chapters={chapters}
            currentChapterIndex={chapterIndex}
            onSelectChapter={selectChapter}
            className="h-full"
          />
        </div>
      </div>

      {isFullscreen && (
        <div
          className="relative flex flex-1 flex-col bg-black"
          onMouseMove={handleFullscreenMouseMove}
          onMouseEnter={() => setShowFullscreenControls(true)}
        >
          {book?.cover && (
            <>
              <img
                src={book.cover}
                alt=""
                className="absolute inset-0 h-full w-full object-cover blur-2xl opacity-30"
              />
              <div className="absolute inset-0 bg-black/50" />
            </>
          )}

          <div className="relative flex flex-1 items-center justify-center">
            {captionsEnabled ? (
              <SubtitleOverlay
                currentTime={subtitleTime}
                cues={cues}
                mode="fullscreen"
              />
            ) : (
              <p className="text-center text-xl text-white/50">Captions disabled</p>
            )}
          </div>

          <div
            className={cn(
              'relative transition-opacity duration-300',
              showFullscreenControls ? 'opacity-100' : 'opacity-0'
            )}
          >
            <div className="flex items-center justify-between bg-gradient-to-t from-black/80 to-transparent px-4 pb-6 pt-12">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={handlePreviousChapter}
                  className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white"
                >
                  <SkipBack className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => handleSeekRelative(-10)}
                  className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="11 17 6 12 11 7" />
                    <polyline points="18 17 13 12 18 7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={togglePlay}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30"
                >
                  {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
                </button>
                <button
                  type="button"
                  onClick={() => handleSeekRelative(10)}
                  className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white"
                >
                  <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="13 17 18 12 13 7" />
                    <polyline points="6 17 11 12 6 7" />
                  </svg>
                </button>
                <button
                  type="button"
                  onClick={handleNextChapter}
                  className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white"
                >
                  <SkipForward className="h-5 w-5" />
                </button>
                <span className="ml-2 text-sm text-white/70">
                  {formatTime(currentTime)} / {formatTime(duration || 0)}
                </span>
              </div>

              <button
                type="button"
                onClick={toggleFullscreen}
                className="rounded p-2 text-white/80 hover:bg-white/10 hover:text-white"
              >
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
  chapter: { start: number; end: number }
): SubtitleCue[] {
  if (cues.length === 0 || chapter.start <= 0) {
    return cues;
  }

  const chapterDuration = Math.max(0, chapter.end - chapter.start);
  if (chapterDuration <= 0) {
    return cues;
  }

  const maxCueEnd = Math.max(...cues.map((cue) => cue.end));
  const timestampTolerance = 2;
  const cuesLookChapterLocal = maxCueEnd <= chapterDuration + timestampTolerance;

  if (!cuesLookChapterLocal) {
    return cues;
  }

  return cues.map((cue) => ({
    ...cue,
    start: cue.start + chapter.start,
    end: cue.end + chapter.start,
    words: cue.words?.map((word) => ({
      ...word,
      start: word.start + chapter.start,
      end: word.end + chapter.start,
    })),
  }));
}
