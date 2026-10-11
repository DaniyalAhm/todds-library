'use client';

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { SessionProvider, signOut, useSession } from 'next-auth/react';
import { useEffect, useRef, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import { getAuthUserId, setAuthSession, setUnauthorizedHandler } from '@/lib/api-client';
import { AuthKeepAlive } from '@/hooks/use-auth-keepalive';
import { Reconnect } from '@/hooks/use-reconnect';
import { routes } from '@/lib/routes';
import { useProgressQueueSync } from '@/hooks/use-progress-queue-sync';
import { registerServiceWorker } from '@/lib/service-worker';

function SessionTokenBridge() {
  useProgressQueueSync();
  const { data: session, status } = useSession();
  const queryClient = useQueryClient();
  const previousUser = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (status !== 'loading') {
      setAuthSession(session?.accessToken ?? null, session?.sessionToken ?? null);
      const currentUser = getAuthUserId();
      if (previousUser.current !== undefined && previousUser.current !== currentUser) queryClient.clear();
      previousUser.current = currentUser;
    }
  }, [session?.accessToken, session?.sessionToken, status, queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(() => signOut({ callbackUrl: routes.login }));
    return () => setUnauthorizedHandler(null);
  }, []);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            retry: 1,
            // Re-fetch when the tab/app regains focus or becomes visible again.
            // Returning from a backgrounded mobile tab otherwise leaves the app
            // showing stale data on dead connections until a manual reload.
            refetchOnWindowFocus: true,
          },
        },
      })
  );

  useEffect(() => {
    registerServiceWorker();
  }, []);

  return (
    <SessionProvider refetchOnWindowFocus>
      <QueryClientProvider client={queryClient}>
        <SessionTokenBridge />
        <AuthKeepAlive />
        <Reconnect />
        {children}
        <Toaster />
      </QueryClientProvider>
    </SessionProvider>
  );
}