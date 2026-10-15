'use client';

import { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { useBook, useBookProgress, useUpdateProgress } from '@/hooks/use-books';
import { captureProgress, getAccessToken, postProgressWithKeepalive, refreshAuthSession } from '@/lib/api-client';
import { clearProgress, enqueueProgress, type ProgressSnapshot } from '@/lib/progress-queue';
import { usePlayer } from '@/hooks/use-player';
import { usePlaybackSpeedSession } from '@/hooks/use-playback-speed-session';
import { useMediaSession } from '@/hooks/use-media-session';
import { AudioPlayerContext } from './audio-player-context';
import { logger } from '@/lib/logger';
import { useContinuousProgressSync } from '@/hooks/use-continuous-progress-sync';

export function PlayerHost({ children }: { children?: React.ReactNode }) {
  usePlaybackSpeedSession();
  const audioRef = useRef<HTMLAudioElement>(null);
  const hlsRef = useRef<any>(null);
  const hlsRetryRef = useRef(false);
  const fatalErrorRef = useRef<() => void>(() => {});
  const [audioSrc, setAudioSrc] = useState('');
  const [audioElement, setAudioElement] = useState<HTMLAudioElement | null>(null);
  const [loadError, setLoadError] = useState('');
  const [triedHls, setTriedHls] = useState(false);
  const [trackIndex, setTrackIndex] = useState(0);
  const hydratedProgressBookRef = useRef<string | null>(null);
  const seekAfterTrackLoadRef = useRef<number | null>(null);
  const playbackTimeFrameRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);
  const wasPlayingBeforeHiddenRef = useRef(false);
  const isReconnectingRef = useRef(false);
  const resumeCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userPauseRequestedRef = useRef(false);
  const audioSetupKeyRef = useRef<string | null>(null);
  const hlsStallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    currentBook: bookId,
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
    seek,
    setVolume: _setVolumeIgnored,
    setSpeed: _setSpeedIgnored,
    setSleepTimer: _setSleepTimerIgnored,
    clearSleepTimer,
    setCurrentBook,
    setCurrentBookInfo,
    setDuration,
    setCurrentTime,
    setChapters,
    setChapterIndex,
  } = usePlayer();

  const { data: book } = useBook(bookId ?? '');
  const { data: progress, isSuccess: progressLoaded } = useBookProgress(bookId ?? '');
  const updateProgress = useUpdateProgress(bookId ?? '');

  // Keep isPlayingRef fresh
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  // Keep currentBookInfo in sync with book metadata (for MiniPlayer)
  useEffect(() => {
    if (book && bookId) {
      setCurrentBookInfo({
        id: book.id,
        title: book.title,
        author: book.author ?? null,
        cover: book.cover ?? null,
      });
    } else if (!bookId) {
      setCurrentBookInfo(null);
    }
  }, [book, bookId, setCurrentBookInfo]);

  // Chapters + duration init from book
  useEffect(() => {
    if (book?.chapters) {
      const chapterList = [...book.chapters].sort((a, b) => a.index - b.index).map((ch: any, idx: number) => ({
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
      if (typeof nextStart === 'number' && nextStart > start) return nextStart - start;
      return Math.max(0, (duration || 0) - start);
    },
    [chapters, duration, trackStart]
  );

  const trackForPosition = useCallback(
    (position: number) => {
      if (chapters.length === 0) return 0;
      if (!Number.isFinite(position) || position <= 0) return 0;
      if (position >= (duration || Number.MAX_SAFE_INTEGER)) return Math.max(0, chapters.length - 1);
      const index = chapters.findIndex(
        (chapter, idx) => position >= chapter.start && position < (chapters[idx + 1]?.start ?? Number.POSITIVE_INFINITY)
      );
      if (index !== -1) return index;
      // Fallback: position within last chapter's start/end even if end==start (zero-duration)
      for (let i = chapters.length - 1; i >= 0; i--) {
        if (position >= chapters[i].start) return i;
      }
      return 0;
    },
    [chapters, duration]
  );

  const withFreshToken = useCallback((url: string): string => {
    const token = getAccessToken();
    if (!token || !url) return url;
    const nextUrl = new URL(url);
    nextUrl.searchParams.set('access_token', token);
    return nextUrl.toString();
  }, []);

  const isHlsStreamUrl = useCallback(
    (url: string): boolean => {
      if (!book?.stream_url || !url) return false;
      try {
        const base = new URL(book.stream_url);
        const candidate = new URL(url);
        return candidate.origin === base.origin && candidate.pathname === base.pathname;
      } catch {
        return false;
      }
    },
    [book?.stream_url]
  );

  const audioUrlForTrack = useCallback(
    (index: number) => {
      if (!book?.audio_download_url) return '';
      const url = new URL(withFreshToken(book.audio_download_url));
      url.searchParams.set('track', String(index));
      return url.toString();
    },
    [book?.audio_download_url, withFreshToken]
  );

  const isMultiTrackDirect = (book?.audio_track_count || 0) > 1;
  const prefersDirectPlayback = useMemo(() => {
    if (isMultiTrackDirect) return true;
    if (typeof navigator === 'undefined') return false;
    return /Android/i.test(navigator.userAgent);
  }, [isMultiTrackDirect]);

  const mediaSessionBook = useMemo(
    () => ({
      title: book?.title || '',
      artist: book?.author || '',
      cover: book?.cover,
    }),
    [book?.title, book?.author, book?.cover]
  );

  useEffect(() => {
    audioSetupKeyRef.current = null;
    hydratedProgressBookRef.current = null;
    setTriedHls(false);
    setTrackIndex(0);
  }, [bookId]);

  // Hydrate progress
  useEffect(() => {
    if (!bookId || book?.id !== bookId || !progressLoaded || hydratedProgressBookRef.current === bookId) return;
    const orderedChapters = [...(book.chapters ?? [])].sort((a, b) => a.index - b.index);
    if (orderedChapters.length !== chapters.length || orderedChapters.some((chapter, index) => chapter.id !== chapters[index]?.id)) return;
    const position = progress?.position || 0;
    if (isMultiTrackDirect) {
      if (chapters.length === 0) return;
      const nextTrackIndex = trackForPosition(position);
      setTrackIndex(nextTrackIndex);
      setCurrentTime(position);
      seekAfterTrackLoadRef.current = Math.max(0, position - trackStart(nextTrackIndex));
      // Metadata may have loaded before the progress request completed. If
      // this track is already ready, there will be no second metadata event.
      const audio = audioRef.current;
      if (audio && audioSetupKeyRef.current?.startsWith(`${bookId}|direct|${nextTrackIndex}|`) && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
        audio.currentTime = seekAfterTrackLoadRef.current;
        seekAfterTrackLoadRef.current = null;
      }
    } else {
      setCurrentTime(position);
      seekAfterTrackLoadRef.current = position;
      const audio = audioRef.current;
      if (audio && audioSetupKeyRef.current?.startsWith(`${bookId}|`) && audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
        audio.currentTime = position;
        seekAfterTrackLoadRef.current = null;
      }
    }
    hydratedProgressBookRef.current = bookId;
  }, [bookId, book, chapters, isMultiTrackDirect, progress, progressLoaded, setCurrentTime, trackForPosition, trackStart]);

  useEffect(() => {
    const audio = audioRef.current;
    setAudioElement((current) => (current === audio ? current : audio));
  }, [audioSrc, bookId]);

  // Ensure audioElement is set on mount (before src exists)
  useEffect(() => {
    setAudioElement(audioRef.current);
  }, []);

  // Keep audio element play/pause in sync with store isPlaying
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying && audio.paused) {
      void audio.play().catch(() => undefined);
    } else if (!isPlaying && !audio.paused) {
      audio.pause();
    }
  }, [isPlaying]);

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

  const reloadAudioSrc = useCallback((url: string) => {
    const audio = audioRef.current;
    setAudioSrc(url);
    if (!audio) return;
    window.setTimeout(() => {
      if (audio.src !== url) audio.src = url;
      audio.load();
      if (isPlayingRef.current) audio.play().catch(() => undefined);
    }, 0);
  }, []);

  const capturePositionForReload = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    let local = audio.currentTime;
    if (local <= 0 || Number.isNaN(local)) {
      local = isMultiTrackDirect ? Math.max(0, currentTime - trackStart(trackIndex)) : currentTime;
    }
    if (local > 0 && !Number.isNaN(local)) seekAfterTrackLoadRef.current = local;
  }, [currentTime, isMultiTrackDirect, trackIndex, trackStart]);

  const fallbackToDirect = useCallback(() => {
    capturePositionForReload();
    setupDirectAudio();
  }, [capturePositionForReload, setupDirectAudio]);

  const setupHlsStream = useCallback(
    async (force = false) => {
      if (!book?.stream_url || (!force && triedHls) || prefersDirectPlayback) {
        setupDirectAudio();
        return;
      }
      const audio = audioRef.current;
      if (!audio) {
        setupDirectAudio();
        return;
      }
      setTriedHls(true);
      setLoadError('');
      // Clear any prior stall timer
      if (hlsStallTimerRef.current) {
        clearTimeout(hlsStallTimerRef.current);
        hlsStallTimerRef.current = null;
      }
      // Fast preflight: if manifest returns 500 or missing segments, fall back to direct immediately
      // (covers single-file wma/m4b where HLS transcode fails on desktop)
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        const probeRes = await fetch(withFreshToken(book.stream_url), { signal: controller.signal });
        clearTimeout(t);
        if (!probeRes.ok) {
          logger.hls.warn('manifest probe failed, falling back to direct:', probeRes.status);
          setupDirectAudio();
          return;
        }
        const text = await probeRes.text();
        if (!text.includes('segment_')) {
          logger.hls.warn('manifest missing segments, falling back to direct');
          setupDirectAudio();
          return;
        }
      } catch (probeErr) {
        logger.hls.warn('manifest probe error, falling back to direct:', probeErr);
        setupDirectAudio();
        return;
      }
      try {
        const Hls = (await import('hls.js')).default;
        if (Hls.isSupported()) {
          if (hlsRef.current) hlsRef.current.destroy();
          hlsRef.current = new Hls({
            xhrSetup: (xhr: XMLHttpRequest, url: string) => {
              xhr.open('GET', withFreshToken(url), true);
            },
            manifestLoadingTimeOut: 8000,
            levelLoadingTimeOut: 8000,
            fragLoadingTimeOut: 10000,
            manifestLoadingMaxRetry: 2,
            levelLoadingMaxRetry: 2,
            fragLoadingMaxRetry: 2,
          });
          setAudioSrc('');
          hlsRef.current.loadSource(withFreshToken(book.stream_url));
          hlsRef.current.attachMedia(audio);
          let manifestParsed = false;
          hlsRef.current.on(Hls.Events.MANIFEST_PARSED, () => {
            manifestParsed = true;
            if (hlsStallTimerRef.current) {
              clearTimeout(hlsStallTimerRef.current);
              hlsStallTimerRef.current = null;
            }
            hlsRetryRef.current = false;
            setDuration(audio.duration || 0);
            audio.play().catch(() => undefined);
          });
          hlsRef.current.on(Hls.Events.ERROR, (_event: unknown, data: any) => {
            if (data?.fatal) {
              if (hlsStallTimerRef.current) {
                clearTimeout(hlsStallTimerRef.current);
                hlsStallTimerRef.current = null;
              }
              fatalErrorRef.current();
            }
          });
          // Stall fallback: if no manifest parsed after 12s, fallback to direct
          hlsStallTimerRef.current = setTimeout(() => {
            if (!manifestParsed) {
              logger.hls.warn('manifest parsing stalled after 12s, falling back to direct');
              if (hlsRef.current) {
                hlsRef.current.destroy();
                hlsRef.current = null;
              }
              fallbackToDirect();
            }
          }, 12000);
          return;
        }
        if (audio.canPlayType('application/vnd.apple.mpegurl')) {
          // Native HLS (Safari) — also probe already succeeded, so set src directly
          setAudioSrc(withFreshToken(book.stream_url));
          return;
        }
      } catch (err) {
        logger.hls.error('Failed to start HLS stream:', err);
      }
      setupDirectAudio();
    },
    [book?.stream_url, fallbackToDirect, prefersDirectPlayback, setDuration, setupDirectAudio, triedHls, withFreshToken]
  );

  const retryStream = useCallback(async () => {
    capturePositionForReload();
    if (hlsRetryRef.current) {
      hlsRetryRef.current = false;
      fallbackToDirect();
      return;
    }
    hlsRetryRef.current = true;
    const outcome = await refreshAuthSession();
    if (outcome === 'invalid') {
      hlsRetryRef.current = false;
      fallbackToDirect();
      return;
    }
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    await setupHlsStream(true);
  }, [capturePositionForReload, fallbackToDirect, setupHlsStream]);

  useEffect(() => {
    fatalErrorRef.current = () => {
      void retryStream();
    };
  }, [retryStream]);

  const getProgressSnapshot = useCallback((): ProgressSnapshot | null => {
    const audio = audioRef.current;
    if (!audio || !bookId || !progressLoaded) return null;
    if (seekAfterTrackLoadRef.current !== null || hydratedProgressBookRef.current !== bookId) return null;
    if (book?.id !== bookId || audio.readyState < 1 || !Number.isFinite(audio.currentTime)) return null;
    const globalPosition = isMultiTrackDirect ? trackStart(trackIndex) + audio.currentTime : audio.currentTime;
    const totalDuration = Number.isFinite(duration) && duration > 0 ? duration : audio.duration;
    if (!Number.isFinite(totalDuration) || totalDuration <= 0) return null;
    return captureProgress({ bookId, progress: Math.min(1, Math.max(0, globalPosition / totalDuration)), position: Math.max(0, globalPosition) });
  }, [bookId, duration, isMultiTrackDirect, trackIndex, trackStart, progressLoaded, progress, book?.id]);

  const saveProgress = useCallback(() => {
    const audio = audioRef.current;
    const snapshot = getProgressSnapshot();
    if (!audio || !snapshot) return;
    if (!bookId) return;
    updateProgress.mutate(
      snapshot,
      {
        onSuccess: () => {
          void clearProgress(snapshot.bookId, snapshot.expected_user_id, snapshot.captured_at);
        },
      }
    );
    if (sleepTimerEnd && Date.now() >= sleepTimerEnd) {
      userPauseRequestedRef.current = true;
      audio.pause();
      clearSleepTimer();
    }
  }, [clearSleepTimer, getProgressSnapshot, sleepTimerEnd, updateProgress, bookId]);

  const reconnectStream = useCallback(async () => {
    if (isReconnectingRef.current) return;
    const audio = audioRef.current;
    if (!audio || !book) return;
    isReconnectingRef.current = true;
    try {
      capturePositionForReload();
      if (isMultiTrackDirect) {
        reloadAudioSrc(audioUrlForTrack(trackIndex));
        return;
      }
      const outcome = await refreshAuthSession();
      if (outcome === 'invalid') return;
      if (prefersDirectPlayback) {
        reloadAudioSrc(audioUrlForTrack(trackIndex));
        return;
      }
      if (hlsRef.current) {
        await setupHlsStream(true);
        return;
      }
      if (book.stream_url && isHlsStreamUrl(book.stream_url)) {
        reloadAudioSrc(withFreshToken(book.stream_url));
        return;
      }
      if (book.audio_download_url) {
        reloadAudioSrc(prefersDirectPlayback ? audioUrlForTrack(trackIndex) : withFreshToken(book.audio_download_url));
      }
    } finally {
      isReconnectingRef.current = false;
    }
  }, [audioUrlForTrack, book, capturePositionForReload, isHlsStreamUrl, isMultiTrackDirect, prefersDirectPlayback, reloadAudioSrc, setupHlsStream, trackIndex, withFreshToken]);

  // Resume monitor for background stall
  useEffect(() => {
    const onResume = () => {
      if (document.visibilityState !== 'visible') return;
      try {
        saveProgress();
      } catch {}
      const audio = audioRef.current;
      const wasPlaying = wasPlayingBeforeHiddenRef.current;
      wasPlayingBeforeHiddenRef.current = false;
      if (resumeCheckTimerRef.current !== null) {
        clearTimeout(resumeCheckTimerRef.current);
        resumeCheckTimerRef.current = null;
      }
      if (!audio || !book || !wasPlaying) return;
      if (audio.paused || audio.ended) {
        void reconnectStream();
        return;
      }
      const sampled = audio.currentTime;
      resumeCheckTimerRef.current = setTimeout(() => {
        resumeCheckTimerRef.current = null;
        const current = audioRef.current;
        if (!current || !isPlayingRef.current) return;
        const stalled = current.paused || current.ended || current.currentTime <= sampled;
        if (stalled) void reconnectStream();
      }, 3000);
    };
    document.addEventListener('visibilitychange', onResume);
    window.addEventListener('pageshow', onResume);
    window.addEventListener('focus', onResume);
    return () => {
      document.removeEventListener('visibilitychange', onResume);
      window.removeEventListener('pageshow', onResume);
      window.removeEventListener('focus', onResume);
      if (resumeCheckTimerRef.current !== null) {
        clearTimeout(resumeCheckTimerRef.current);
        resumeCheckTimerRef.current = null;
      }
    };
  }, [book, reconnectStream, saveProgress]);

  const setupAudio = useCallback(async () => {
    if (!book || book.id !== bookId) return;
    const setupKey = [
      book.id,
      prefersDirectPlayback ? 'direct' : 'hls',
      isMultiTrackDirect ? trackIndex : 0,
      book.audio_download_url ? new URL(book.audio_download_url).pathname : '',
      book.stream_url ? new URL(book.stream_url).pathname : '',
    ].join('|');
    const audio = audioRef.current;
    const hasActiveMedia = Boolean(hlsRef.current || audioSrc || audio?.currentSrc);
    if (audioSetupKeyRef.current === setupKey && hasActiveMedia) return;
    audioSetupKeyRef.current = setupKey;
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setLoadError('');
    setAudioSrc('');
    if (prefersDirectPlayback) {
      setupDirectAudio();
      return;
    }
    await setupHlsStream(true);
  }, [audioSrc, book, bookId, isMultiTrackDirect, prefersDirectPlayback, setupDirectAudio, setupHlsStream, trackIndex]);

  useEffect(() => {
    if (!bookId) {
      const audio = audioRef.current;
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (hlsStallTimerRef.current) {
        clearTimeout(hlsStallTimerRef.current);
        hlsStallTimerRef.current = null;
      }
      setAudioSrc('');
      setLoadError('');
      return;
    }
    void setupAudio();
  }, [setupAudio, bookId]);

  useEffect(() => {
    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (hlsStallTimerRef.current) {
        clearTimeout(hlsStallTimerRef.current);
        hlsStallTimerRef.current = null;
      }
    };
  }, [bookId]);

  const syncCurrentTimeFromAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || seekAfterTrackLoadRef.current !== null || audio.readyState < 1) return;
    const globalTime = isMultiTrackDirect ? trackStart(trackIndex) + audio.currentTime : audio.currentTime;
    setCurrentTime(globalTime);
  }, [isMultiTrackDirect, setCurrentTime, trackIndex, trackStart]);

  // timeupdate / durationchange listeners
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTimeUpdate = () => syncCurrentTimeFromAudio();
    const onDurationChange = () => {
      if (!isMultiTrackDirect) setDuration(audio.duration);
    };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('durationchange', onDurationChange);
    return () => {
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('durationchange', onDurationChange);
    };
  }, [setDuration, audioSrc, isMultiTrackDirect, syncCurrentTimeFromAudio, bookId]);

  // RAF tick when playing
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
      const audio = audioRef.current;
      if (audio && !audio.paused && seekAfterTrackLoadRef.current === null && audio.readyState >= 1) {
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
    const audio = audioRef.current;
    if (audio) audio.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) {
      // Re-applied on audioSrc change because setting src / calling
      // load() (direct playback, track switches, reconnects — the
      // dominant Android path) resets playbackRate to 1.0.
      audio.playbackRate = speed;
      audio.defaultPlaybackRate = speed;
    }
  }, [speed, audioSrc]);

  // chapter index sync
  useEffect(() => {
    if (chapters.length > 0 && currentTime >= 0) {
      const idx = chapters.findIndex(
        (ch, index) => currentTime >= ch.start && currentTime < (ch.end || chapters[index + 1]?.start || duration || Number.POSITIVE_INFINITY)
      );
      if (idx >= 0 && idx !== chapterIndex) setChapterIndex(idx);
    }
  }, [currentTime, chapters, chapterIndex, duration, setChapterIndex]);

  // Media session + keep-alive queues — placeholder, real impl after formatSeek (cross-track aware)
  // handleSeekRelative is defined after formatSeek to avoid circular deps

  const formatSeek = useCallback(
    (time: number) => {
      const clamped = Number.isFinite(time) ? Math.max(0, Math.min(time, duration || Number.MAX_SAFE_INTEGER)) : 0;
      seek(clamped);
      if (isMultiTrackDirect) {
        const nextTrackIndex = trackForPosition(clamped);
        const localTime = Math.max(0, clamped - trackStart(nextTrackIndex));
        if (nextTrackIndex !== trackIndex) {
          // Invalidate setupKey so setupAudio does not block track switch
          audioSetupKeyRef.current = null;
          seekAfterTrackLoadRef.current = localTime;
          // Keep chapterIndex in sync with track for Dune (1:1 track:chapter)
          setChapterIndex(nextTrackIndex);
          setTrackIndex(nextTrackIndex);
          setAudioSrc(audioUrlForTrack(nextTrackIndex));
          // Force load for new track src (raw audio does not auto-load on src prop change)
          window.setTimeout(() => {
            const a = audioRef.current;
            if (a) {
              a.load();
              if (isPlayingRef.current) void a.play().catch(() => undefined);
            }
          }, 0);
          return;
        }
        const audio = audioRef.current;
        if (audio) {
          // If audio not yet ready, defer via seekAfterTrackLoadRef (handled in onLoadedMetadata)
          if (audio.readyState >= 1) audio.currentTime = localTime;
          else seekAfterTrackLoadRef.current = localTime;
        }
        return;
      }
      const audio = audioRef.current;
      if (audio) {
        if (audio.readyState >= 1) audio.currentTime = clamped;
        else seekAfterTrackLoadRef.current = clamped;
      }
    },
    [seek, isMultiTrackDirect, trackForPosition, trackStart, trackIndex, audioUrlForTrack, duration, setChapterIndex]
  );

  // Cross-track aware rewind/forward: uses global currentTime + delta then delegates to formatSeek
  const handleSeekRelative = useCallback(
    (delta: number) => {
      const target = Math.max(0, Math.min(duration || Number.MAX_SAFE_INTEGER, currentTime + delta));
      formatSeek(target);
    },
    [currentTime, duration, formatSeek]
  );

  const handleNativeAudioSeek = useCallback(
    (localTime: number) => {
      if (seekAfterTrackLoadRef.current !== null) return;
      if (isMultiTrackDirect) seek(trackStart(trackIndex) + localTime);
      else seek(localTime);
    },
    [isMultiTrackDirect, seek, trackStart, trackIndex]
  );

  const handlePreviousChapter = useCallback(() => {
    const previousIndex = currentTime - (chapters[chapterIndex]?.start || 0) > 5 ? chapterIndex : Math.max(0, chapterIndex - 1);
    setChapterIndex(previousIndex);
    formatSeek(chapters[previousIndex]?.start || 0);
  }, [currentTime, chapters, chapterIndex, setChapterIndex, formatSeek]);

  const handleNextChapter = useCallback(() => {
    const nextIndex = Math.min(chapters.length - 1, chapterIndex + 1);
    setChapterIndex(nextIndex);
    formatSeek(chapters[nextIndex]?.start || duration);
  }, [chapterIndex, chapters, duration, formatSeek, setChapterIndex]);

  const handleTrackEnded = useCallback(() => {
    saveProgress();
    if (isMultiTrackDirect && trackIndex < (book?.audio_track_count || 1) - 1) {
      const nextIndex = trackIndex + 1;
      setTrackIndex(nextIndex);
      setChapterIndex(nextIndex);
      seekAfterTrackLoadRef.current = 0;
      setAudioSrc(audioUrlForTrack(nextIndex));
      return;
    }
    if (chapterIndex < chapters.length - 1) handleNextChapter();
    else {
      userPauseRequestedRef.current = true;
      pause();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveProgress, isMultiTrackDirect, trackIndex, book?.audio_track_count, setChapterIndex, audioUrlForTrack, chapterIndex, chapters.length, handleNextChapter, pause]);

  const pauseAudioByUser = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    userPauseRequestedRef.current = true;
    audio.pause();
  }, []);

  const playAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    userPauseRequestedRef.current = false;
    void audio.play();
  }, []);

  const toggleAudio = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) playAudio();
    else pauseAudioByUser();
  }, [pauseAudioByUser, playAudio]);

  const flushProgress = useCallback(() => {
    const snapshot = getProgressSnapshot();
    if (!snapshot) return;
    postProgressWithKeepalive(snapshot.bookId, snapshot);
  }, [getProgressSnapshot]);

  const queueCurrentPosition = useCallback(() => {
    const snapshot = getProgressSnapshot();
    if (!snapshot) return;
    postProgressWithKeepalive(snapshot.bookId, snapshot);
    void enqueueProgress(snapshot);
  }, [flushProgress, getProgressSnapshot]);

  const handlePause = useCallback(() => {
    saveProgress();
    queueCurrentPosition();
    const hiddenSystemPause =
      document.visibilityState === 'hidden' && wasPlayingBeforeHiddenRef.current && !userPauseRequestedRef.current;
    if (hiddenSystemPause) return;
    userPauseRequestedRef.current = false;
    pause();
  }, [pause, queueCurrentPosition, saveProgress]);

  useEffect(() => {
    const snapshotPlaybackState = () => {
      wasPlayingBeforeHiddenRef.current = isPlayingRef.current;
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        snapshotPlaybackState();
        queueCurrentPosition();
      }
    };
    const onPageHide = () => {
      snapshotPlaybackState();
      queueCurrentPosition();
    };
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [queueCurrentPosition]);

  useMediaSession({
    book: mediaSessionBook,
    audio: audioElement,
    isPlaying,
    currentTime,
    duration,
    playbackRate: speed,
    onTogglePlay: toggleAudio,
    onPlay: playAudio,
    onPause: pauseAudioByUser,
    onNext: handleNextChapter,
    onPrevious: handlePreviousChapter,
    onSeekTo: formatSeek,
    onSeekBy: handleSeekRelative,
  });

  useEffect(() => {
    if (!isPlaying) return;
    const timer = setInterval(() => {
      void refreshAuthSession();
    }, 60_000);
    return () => clearInterval(timer);
  }, [isPlaying]);

  const selectChapter = useCallback(
    (idx: number) => {
      setChapterIndex(idx);
      formatSeek(chapters[idx]?.start || 0);
    },
    [chapters, formatSeek, setChapterIndex]
  );

  // Audio element event handlers
  const handleLoadedMetadata = useCallback(
    (e: React.SyntheticEvent<HTMLAudioElement>) => {
      const audio = e.currentTarget;
      // load() resets playbackRate to 1.0 — restore the user's selected
      // speed once metadata is available (reliable on Android Chrome).
      const currentSpeed = usePlayer.getState().speed;
      audio.playbackRate = currentSpeed;
      audio.defaultPlaybackRate = currentSpeed;
      if (!isMultiTrackDirect) setDuration(audio.duration || 0);
      if (seekAfterTrackLoadRef.current !== null) {
        audio.currentTime = seekAfterTrackLoadRef.current;
        seekAfterTrackLoadRef.current = null;
        if (isPlayingRef.current) void audio.play().catch(() => undefined);
      }
    },
    [isMultiTrackDirect, setDuration]
  );

  const handleTimeUpdateWrapper = useCallback(
    (e: React.SyntheticEvent<HTMLAudioElement>) => {
      handleNativeAudioSeek(e.currentTarget.currentTime);
    },
    [handleNativeAudioSeek]
  );

  const handleError = useCallback(() => {
    const audio = audioRef.current;
    const currentSrc = audio?.currentSrc || audioSrc;
    if (!currentSrc) return;
    // When hls.js is attached (audioSrc === '' but hls owns MediaSource), ignore spurious
    // empty-src errors but still handle real decode errors (error.code !== 0)
    if (hlsRef.current && !audioSrc) {
      if (!audio?.error || audio.error.code === 0) return;
    }
    capturePositionForReload();
    // For native HLS url (canPlayType) currentSrc will be blob-free stream url
    if (book?.audio_download_url && isHlsStreamUrl(currentSrc)) fallbackToDirect();
    else if (book?.audio_download_url && hlsRef.current) {
      // hls.js owned blob: currentSrc is blob: — still fallback to direct
      fallbackToDirect();
    } else if (!triedHls) void setupHlsStream();
    else setLoadError('Audio failed to load.');
  }, [audioSrc, book?.audio_download_url, capturePositionForReload, fallbackToDirect, isHlsStreamUrl, setupHlsStream, triedHls]);

  // Continuous 0.5s sync: frontend POSTs timestamps to backend which writes to DB
  useContinuousProgressSync(!!isPlaying && !!bookId, getProgressSnapshot, 500);

  // periodic saveProgress every 30s (onListen equivalent) — kept as fallback heartbeat
  useEffect(() => {
    if (!isPlaying) return;
    const id = setInterval(() => saveProgress(), 30000);
    return () => clearInterval(id);
  }, [isPlaying, saveProgress]);

  const value = useMemo(
    () => ({
      audioRef: audioRef as React.RefObject<HTMLAudioElement>,
      audioElement,
      audioSrc,
      loadError,
      trackIndex,
      isMultiTrackDirect,
      prefersDirectPlayback,
      play: playAudio,
      pause: pauseAudioByUser,
      toggle: toggleAudio,
      seek: formatSeek,
      seekRelative: handleSeekRelative,
      nextChapter: handleNextChapter,
      prevChapter: handlePreviousChapter,
      selectChapter,
      setTrackIndex,
      clearError: () => setLoadError(''),
      triedHls,
    }),
    [audioElement, audioSrc, loadError, trackIndex, isMultiTrackDirect, prefersDirectPlayback, playAudio, pauseAudioByUser, toggleAudio, formatSeek, handleSeekRelative, handleNextChapter, handlePreviousChapter, selectChapter, triedHls]
  );

  return (
    <AudioPlayerContext.Provider value={value}>
      {/* Hidden but not display:none so iOS can keep it alive in background */}
      <audio
        ref={audioRef}
        src={audioSrc || undefined}
        preload={prefersDirectPlayback ? 'auto' : 'metadata'}
        onLoadedMetadata={handleLoadedMetadata}
        onTimeUpdate={handleTimeUpdateWrapper}
        onPause={handlePause}
        onPlay={play}
        onEnded={handleTrackEnded}
        onError={handleError}
        // Keep alive: allow background playback, do not show controls here
        className="fixed -left-[9999px] top-0 h-1 w-1 opacity-0 pointer-events-none"
        aria-hidden
      />
      {children}
    </AudioPlayerContext.Provider>
  );
}
