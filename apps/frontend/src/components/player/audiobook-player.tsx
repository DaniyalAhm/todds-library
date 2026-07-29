'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import AudioPlayer from 'react-h5-audio-player';
import { useBook, useBookProgress, useUpdateProgress } from '@/hooks/use-books';
import { usePlayer } from '@/hooks/use-player';
import { ChapterList } from './chapter-list';
import { SleepTimer } from './sleep-timer';
import { Slider } from '@/components/ui/slider';
import { Headphones } from 'lucide-react';
import { SubtitleOverlay, loadSubtitleFile } from '@/components/reader/subtitle-overlay';
import type { SubtitleCue } from '@/components/reader/subtitle-overlay';

interface AudiobookPlayerProps {
  bookId: string;
}

export function AudiobookPlayer({ bookId }: AudiobookPlayerProps) {
  const { data: book } = useBook(bookId);
  const { data: progress } = useBookProgress(bookId);
  const updateProgress = useUpdateProgress(bookId);
  const playerRef = useRef<AudioPlayer>(null);
  const hlsRef = useRef<any>(null);
  const [audioSrc, setAudioSrc] = useState('');
  const [loadError, setLoadError] = useState('');
  const [triedHls, setTriedHls] = useState(false);
  const [trackIndex, setTrackIndex] = useState(0);
  const [cues, setCues] = useState<SubtitleCue[]>([]);
  const seekAfterTrackLoadRef = useRef<number | null>(null);

  const {
    currentTime,
    duration,
    volume,
    speed,
    chapterIndex,
    chapters,
    sleepTimerEnd,
    play,
    pause,
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
    if (progress && chapters.length > 0 && isMultiTrackDirect) {
      const position = progress.position || 0;
      const nextTrackIndex = trackForPosition(position);
      setTrackIndex(nextTrackIndex);
      seek(position);
      seekAfterTrackLoadRef.current = Math.max(0, position - trackStart(nextTrackIndex));
    }
  }, [chapters.length, isMultiTrackDirect, progress, seek, trackForPosition, trackStart]);

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

  useEffect(() => {
    const audio = playerRef.current?.audio.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      const globalTime = isMultiTrackDirect ? trackStart(trackIndex) + audio.currentTime : audio.currentTime;
      setCurrentTime(globalTime);
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
  }, [setCurrentTime, setDuration, audioSrc, isMultiTrackDirect, trackIndex, trackStart]);

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
      loadSubtitleFile(bookId, currentChapter.id).then(setCues).catch(() => setCues([]));
    }
  }, [chapterIndex, chapters, bookId]);

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

  const sleepRemaining = sleepTimerEnd
    ? Math.ceil((sleepTimerEnd - Date.now()) / 60000)
    : undefined;

  return (
      <div className="flex h-full flex-col">
      <div className="flex flex-1 overflow-hidden">
        <div className="flex min-w-0 flex-1 flex-col items-center overflow-y-auto p-4 sm:justify-center sm:p-6 lg:p-8">
          <div className="mb-5 sm:mb-8">
            <div className="relative mx-auto aspect-[2/3] w-36 overflow-hidden rounded-xl bg-muted shadow-2xl sm:w-48 md:w-56 lg:w-64">
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

          <div className="mb-2 text-center">
            <h2 className="line-clamp-2 text-lg font-bold text-foreground sm:text-xl">{book?.title}</h2>
            {book?.author && (
              <p className="text-sm text-muted-foreground">{book.author}</p>
            )}
          </div>

          <div className="w-full max-w-lg min-w-0">
            {loadError && (
              <p className="mb-3 text-sm text-destructive">{loadError}</p>
            )}
            <div className="relative">
              <AudioPlayer
                ref={playerRef}
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
                  handleSeek(audio.currentTime);
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
              <SubtitleOverlay currentTime={currentTime} cues={cues} />
            </div>

            <div className="mt-4 grid gap-3 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-4">
              <div className="flex items-center justify-center gap-2">
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

              <div className="flex items-center justify-center gap-2">
                <span className="text-xs text-muted-foreground">Vol:</span>
                <Slider
                  value={[volume * 100]}
                  max={100}
                  step={1}
                  onValueChange={([v]) => setVolume(v / 100)}
                  className="w-28 sm:w-20"
                />
              </div>

              <SleepTimer
                isActive={!!sleepTimerEnd}
                remainingMinutes={sleepRemaining}
                onSetTimer={(m) => setSleepTimer(m === -1 ? 9999 : m)}
                onClearTimer={clearSleepTimer}
              />
            </div>
          </div>
        </div>

        <div className="hidden w-96 shrink-0 border-l border-border bg-card lg:block">
          <ChapterList
            chapters={chapters}
            currentChapterIndex={chapterIndex}
            onSelectChapter={(idx) => {
              setChapterIndex(idx);
              handleSeek(chapters[idx]?.start || 0);
            }}
          />
        </div>
      </div>
    </div>
  );
}
