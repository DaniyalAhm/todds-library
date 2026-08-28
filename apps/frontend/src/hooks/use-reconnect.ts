'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { refreshAuthSession } from '@/lib/api-client';

// Re-connect the app after a backgrounded/suspended mobile tab resumes.
// Browsers kill the network connections while the page is hidden, so without
// this the first interaction after returning can hang (or fail) until a manual
// reload. On resume we refresh the session token (which itself opens a fresh
// connection) and invalidate active queries so the UI rehydrates.
export function useReconnect() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const onReconnect = () => {
      if (document.visibilityState === 'hidden') return;
      void refreshAuthSession();
      void queryClient.invalidateQueries();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        onReconnect();
      }
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', onReconnect);
    window.addEventListener('focus', onReconnect);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', onReconnect);
      window.removeEventListener('focus', onReconnect);
    };
  }, [queryClient]);
}

export function Reconnect() {
  useReconnect();
  return null;
}