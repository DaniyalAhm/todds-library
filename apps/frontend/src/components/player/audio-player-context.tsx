'use client';

import { createContext, useContext } from 'react';

export interface AudioPlayerContextValue {
  audioRef: React.RefObject<HTMLAudioElement>;
  audioElement: HTMLAudioElement | null;
  audioSrc: string;
  loadError: string;
  trackIndex: number;
  isMultiTrackDirect: boolean;
  prefersDirectPlayback: boolean;
  play: () => void;
  pause: () => void;
  toggle: () => void;
  seek: (time: number) => void;
  seekRelative: (delta: number) => void;
  nextChapter: () => void;
  prevChapter: () => void;
  selectChapter: (idx: number) => void;
  setTrackIndex: (idx: number) => void;
  clearError: () => void;
  // exposed for view to handle HLS fallback UI
  triedHls: boolean;
}

export const AudioPlayerContext = createContext<AudioPlayerContextValue | null>(null);

export function useAudioPlayer(): AudioPlayerContextValue {
  const ctx = useContext(AudioPlayerContext);
  if (!ctx) throw new Error('useAudioPlayer must be used within PlayerHost');
  return ctx;
}
