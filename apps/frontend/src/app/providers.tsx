'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider, useSession } from 'next-auth/react';
import { useEffect, useState } from 'react';
import { Toaster } from '@/components/ui/toast';
import { setSessionToken } from '@/lib/api-client';

function SessionTokenBridge() {
  const { data: session } = useSession();

  useEffect(() => {
    setSessionToken(session?.accessToken ?? null);
  }, [session?.accessToken]);

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
    <SessionProvider>
      <QueryClientProvider client={queryClient}>
        <SessionTokenBridge />
        {children}
        <Toaster />
      </QueryClientProvider>
    </SessionProvider>
  );
}
