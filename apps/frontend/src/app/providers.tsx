'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider, signOut, useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import { setAuthSession, setUnauthorizedHandler } from '@/lib/api-client';
import { routes } from '@/lib/routes';

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
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <SessionProvider refetchOnWindowFocus={false}>
      <QueryClientProvider client={queryClient}>
        <SessionTokenBridge />
        {children}
        <Toaster />
      </QueryClientProvider>
    </SessionProvider>
  );
}
