'use client';

import { useCallback, useRef, useState } from 'react';
import { api, getApiUrl, getAuthHeaders } from '@/lib/api-client';

interface TTSVoice {
  id: string;
  name: string;
  language: string;
  is_cloned: boolean;
}

interface TTSState {
  isPlaying: boolean;
  isLoading: boolean;
  currentVoice: string | null;
  playbackRate: number;
  voices: TTSVoice[];
}

export function useTTS(bookId: string) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<TTSState>({
    isPlaying: false,
    isLoading: false,
    currentVoice: null,
    playbackRate: 1,
    voices: [],
  });

  const loadVoices = useCallback(async () => {
    try {
      const voices = await api.get<TTSVoice[]>('/tts/voices');
      setState((s) => ({
        ...s,
        voices,
        currentVoice: s.currentVoice || voices[0]?.id || null,
      }));
    } catch {}
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!text.trim()) return;

      try {
        setState((s) => ({ ...s, isLoading: true }));

        if (audioRef.current) {
          audioRef.current.pause();
          audioRef.current = null;
        }

        const url = getApiUrl(`/books/${bookId}/tts/synthesize`);
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...getAuthHeaders(),
          },
          body: JSON.stringify({
            text,
            voice: state.currentVoice,
          }),
        });

        if (!response.ok) throw new Error('TTS synthesis failed');

        const audioBlob = await response.blob();
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.playbackRate = state.playbackRate;

        audio.addEventListener('ended', () => {
          setState((s) => ({ ...s, isPlaying: false, isLoading: false }));
          URL.revokeObjectURL(audioUrl);
        });

        audio.addEventListener('error', () => {
          setState((s) => ({ ...s, isPlaying: false, isLoading: false }));
          URL.revokeObjectURL(audioUrl);
        });

        audioRef.current = audio;
        await audio.play();
        setState((s) => ({ ...s, isPlaying: true, isLoading: false }));
      } catch (err) {
        console.error('TTS error:', err);
        setState((s) => ({ ...s, isLoading: false, isPlaying: false }));
      }
    },
    [bookId, state.currentVoice, state.playbackRate]
  );

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    setState((s) => ({ ...s, isPlaying: false, isLoading: false }));
  }, []);

  const setVoice = useCallback((voiceId: string) => {
    setState((s) => ({ ...s, currentVoice: voiceId }));
  }, []);

  const setPlaybackRate = useCallback((rate: number) => {
    setState((s) => {
      if (audioRef.current) {
        audioRef.current.playbackRate = rate;
      }
      return { ...s, playbackRate: rate };
    });
  }, []);

  const cloneVoice = useCallback(async (name: string, file: File) => {
    const formData = new FormData();
    formData.append('name', name);
    formData.append('audio', file);

    const response = await fetch(getApiUrl('/tts/voices/clone'), {
      method: 'POST',
      headers: getAuthHeaders(),
      body: formData,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ detail: 'Clone failed' }));
      throw new Error(err.detail || 'Voice cloning failed');
    }

    const result = await response.json();
    await loadVoices();
    return result as { voice_id: string; name: string };
  }, [loadVoices]);

  return {
    ...state,
    loadVoices,
    speak,
    stop,
    setVoice,
    setPlaybackRate,
    cloneVoice,
  };
}

export type { TTSVoice };
