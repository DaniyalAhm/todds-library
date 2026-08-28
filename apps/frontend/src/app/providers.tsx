'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider, signOut, useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import { setAuthSession, setUnauthorizedHandler } from '@/lib/api-client';
import { AuthKeepAlive } from '@/hooks/use-auth-keepalive';
import { Reconnect } from '@/hooks/use-reconnect';
import { routes } from '@/lib/routes';
import { registerServiceWorker } from '@/lib/service-worker';

function SessionTokenBridge() {
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status !== 'loading') {
      setAuthSession(session?.accessToken ?? null, session?.sessionToken ?? null);
    }
  }, [session?.accessToken, session?.sessionToken, status]);

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