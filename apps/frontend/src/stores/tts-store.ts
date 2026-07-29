'use client';

import { create } from 'zustand';

interface TTSState {
  isPlaying: boolean;
  playbackRate: number;
  currentVoice: string | null;
  visible: boolean;
}

interface TTSActions {
  setPlaying: (playing: boolean) => void;
  setPlaybackRate: (rate: number) => void;
  setCurrentVoice: (voice: string | null) => void;
  setVisible: (visible: boolean) => void;
  reset: () => void;
}

type TTSStore = TTSState & TTSActions;

const initialState: TTSState = {
  isPlaying: false,
  playbackRate: 1,
  currentVoice: null,
  visible: false,
};

export const useTtsStore = create<TTSStore>((set) => ({
  ...initialState,
  setPlaying: (playing) => set({ isPlaying: playing }),
  setPlaybackRate: (rate) => set({ playbackRate: rate }),
  setCurrentVoice: (voice) => set({ currentVoice: voice }),
  setVisible: (visible) => set({ visible }),
  reset: () => set(initialState),
}));
