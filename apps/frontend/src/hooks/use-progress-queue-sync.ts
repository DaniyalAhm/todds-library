'use client';

import { useEffect } from 'react';
import { replayProgressQueue } from '@/lib/progress-queue';

export function useProgressQueueSync() {
  useEffect(() => {
    const sync = () => { void replayProgressQueue(); };
    const interval = setInterval(sync, 5000);
    window.addEventListener('online', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      clearInterval(interval);
      window.removeEventListener('online', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);
}
