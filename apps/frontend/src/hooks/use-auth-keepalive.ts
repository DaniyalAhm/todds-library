'use client';

import { useEffect } from 'react';
import { refreshAuthSession } from '@/lib/api-client';

const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

export function useAuthKeepAlive() {
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;

    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void refreshAuthSession();
      }
    };

    const start = () => {
      if (timer === null) {
        timer = setInterval(refresh, REFRESH_INTERVAL_MS);
      }
    };

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        void refreshAuthSession();
        start();
      } else {
        stop();
      }
    };

    const onPageShow = () => {
      void refreshAuthSession();
      start();
    };

    const onFocus = () => {
      void refreshAuthSession();
      start();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('focus', onFocus);
    start();

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('focus', onFocus);
    };
  }, []);
}

export function AuthKeepAlive() {
  useAuthKeepAlive();
  return null;
}
