'use client';

import { useEffect, useRef } from 'react';

export interface MediaSessionBook {
  title: string;
  artist?: string;
  album?: string;
  cover?: string;
}

interface UseMediaSessionOptions {
  book: MediaSessionBook | null | undefined;
  audio: HTMLAudioElement | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  playbackRate: number;
  onTogglePlay: () => void;
  onPause?: () => void;
  onPlay?: () => void;
  onNext: () => void;
  onPrevious: () => void;
  onSeekTo: (time: number) => void;
  onSeekBy: (delta: number) => void;
}

const POSITION_UPDATE_INTERVAL_MS = 1000;

function mediaSessionSupported(): boolean {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator;
}

export function useMediaSession(options: UseMediaSessionOptions) {
  const {
    book,
    audio,
    isPlaying,
    currentTime,
    duration,
    playbackRate,
    onTogglePlay,
    onPause,
    onPlay,
    onNext,
    onPrevious,
    onSeekTo,
    onSeekBy,
  } = options;

  const handlersRef = useRef({
    audio,
    onTogglePlay,
    onPause,
    onPlay,
    onNext,
    onPrevious,
    onSeekTo,
    onSeekBy,
  });
  handlersRef.current = { audio, onTogglePlay, onPause, onPlay, onNext, onPrevious, onSeekTo, onSeekBy };

  useEffect(() => {
    if (!mediaSessionSupported()) return;
    const session = navigator.mediaSession;

    try {
      session.metadata = new MediaMetadata({
        title: book?.title || '',
        artist: book?.artist || '',
        album: book?.album || '',
        artwork: book?.cover ? [{ src: book.cover, sizes: '512x512' }] : [],
      });
    } catch {
      // MediaMetadata is unsupported on some older browsers.
    }

    const handlers: Array<[MediaSessionAction, MediaSessionActionHandler]> = [
      [
        'play',
        () => {
          if (handlersRef.current.onPlay) {
            handlersRef.current.onPlay();
            return;
          }
          const element = handlersRef.current.audio;
          if (element) void element.play();
          else handlersRef.current.onTogglePlay();
        },
      ],
      [
        'pause',
        () => {
          if (handlersRef.current.onPause) {
            handlersRef.current.onPause();
            return;
          }
          const element = handlersRef.current.audio;
          if (element) element.pause();
          else handlersRef.current.onTogglePlay();
        },
      ],
      ['previoustrack', () => handlersRef.current.onPrevious()],
      ['nexttrack', () => handlersRef.current.onNext()],
      [
        'seekto',
        (details) => {
          if (typeof details.seekTime === 'number') {
            handlersRef.current.onSeekTo(details.seekTime);
          }
        },
      ],
      [
        'seekbackward',
        (details) => handlersRef.current.onSeekBy(-(details.seekOffset ?? 10)),
      ],
      [
        'seekforward',
        (details) => handlersRef.current.onSeekBy(details.seekOffset ?? 10),
      ],
    ];

    handlers.forEach(([action, handler]) => {
      try {
        session.setActionHandler(action, handler);
      } catch {
        // Action not supported by this browser/OS; ignore.
      }
    });

    return () => {
      handlers.forEach(([action]) => {
        try {
          session.setActionHandler(action, null);
        } catch {
          // Ignore cleanup failures.
        }
      });
    };
  }, [book]);

  useEffect(() => {
    if (!mediaSessionSupported()) return;
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  const lastPositionUpdateRef = useRef(0);

  useEffect(() => {
    if (!mediaSessionSupported()) return;
    const now = Date.now();
    if (now - lastPositionUpdateRef.current < POSITION_UPDATE_INTERVAL_MS) return;
    lastPositionUpdateRef.current = now;
    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    try {
      navigator.mediaSession.setPositionState({
        duration: safeDuration,
        playbackRate,
        position: Math.min(currentTime, safeDuration || currentTime),
      });
    } catch {
      // setPositionState is unsupported on some browsers (e.g. older iOS).
    }
  }, [currentTime, duration, playbackRate]);
}
