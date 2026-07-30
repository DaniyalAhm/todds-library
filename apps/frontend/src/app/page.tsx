'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { getSetupStatus } from '@/lib/auth-api';
import { routes } from '@/lib/routes';

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (isLoading) {
      return;
    }

    if (isAuthenticated) {
      router.replace(routes.dashboard);
      return;
    }

    const redirectForSetupStatus = async () => {
      try {
        const data = await getSetupStatus();
        router.replace(data.needs_setup ? routes.register : routes.login);
        return;
      } catch {
        // Fall through to the normal login page if setup status is unavailable.
      }

      router.replace(routes.login);
    };

    redirectForSetupStatus();
  }, [isAuthenticated, isLoading, router]);

  return (
    <div className="flex h-screen items-center justify-center bg-background">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  );
}
