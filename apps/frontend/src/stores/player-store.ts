import { create } from 'zustand';

interface Chapter {
  id: string;
  title: string;
  start: number;
  end: number;
}

interface PlayerState {
  currentBook: string | null;
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  speed: number;
  chapterIndex: number;
  chapters: Chapter[];
  sleepTimerEnd: number | null;
}

interface PlayerActions {
  play: () => void;
  pause: () => void;
  togglePlay: () => void;
  seek: (time: number) => void;
  setVolume: (volume: number) => void;
  setSpeed: (speed: number) => void;
  nextChapter: () => void;
  prevChapter: () => void;
  setSleepTimer: (minutes: number) => void;
  clearSleepTimer: () => void;
  setCurrentBook: (bookId: string | null) => void;
  setDuration: (duration: number) => void;
  setCurrentTime: (time: number) => void;
  setChapterIndex: (index: number) => void;
  setChapters: (chapters: Chapter[]) => void;
  reset: () => void;
}

type PlayerStore = PlayerState & PlayerActions;

const initialState: PlayerState = {
  currentBook: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 1,
  speed: 1,
  chapterIndex: 0,
  chapters: [],
  sleepTimerEnd: null,
};

export const playerStore = create<PlayerStore>((set, get) => ({
  ...initialState,

  play: () => set({ isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  togglePlay: () => set((state) => ({ isPlaying: !state.isPlaying })),

  seek: (time: number) => {
    set({ currentTime: Math.max(0, Math.min(time, get().duration)) });
  },

  setVolume: (volume: number) => {
    set({ volume: Math.max(0, Math.min(1, volume)) });
  },

  setSpeed: (speed: number) => {
    set({ speed: Math.max(0.5, Math.min(3, speed)) });
  },

  nextChapter: () => {
    const { chapterIndex, chapters } = get();
    if (chapterIndex < chapters.length - 1) {
      const nextIdx = chapterIndex + 1;
      set({ chapterIndex: nextIdx, currentTime: chapters[nextIdx].start });
    }
  },

  prevChapter: () => {
    const { chapterIndex, chapters, currentTime } = get();
    if (chapters.length === 0) return;
    const currentChapter = chapters[chapterIndex];
    if (currentTime - currentChapter.start > 5) {
      set({ currentTime: currentChapter.start });
    } else if (chapterIndex > 0) {
      const prevIdx = chapterIndex - 1;
      set({ chapterIndex: prevIdx, currentTime: chapters[prevIdx].start });
    }
  },

  setSleepTimer: (minutes: number) => {
    set({ sleepTimerEnd: Date.now() + minutes * 60 * 1000 });
  },

  clearSleepTimer: () => set({ sleepTimerEnd: null }),

  setCurrentBook: (bookId: string | null) => set({ currentBook: bookId }),
  setDuration: (duration: number) => set({ duration }),
  setCurrentTime: (time: number) => set({ currentTime: time }),
  setChapterIndex: (index: number) => {
    const { chapters } = get();
    set({ chapterIndex: Math.max(0, Math.min(index, Math.max(0, chapters.length - 1))) });
  },
  setChapters: (chapters: Chapter[]) => set({ chapters }),
  reset: () => set(initialState),
}));
