'use client';

import { useSession, signIn, signOut } from 'next-auth/react';
import { useCallback } from 'react';
import { routes } from '@/lib/routes';

export function useAuth() {
  const { data: session, status } = useSession();

  const user = session?.user ?? null;
  const isLoading = status === 'loading';
  const isAuthenticated = status === 'authenticated';

  const login = useCallback(() => signIn('authentik'), []);
  const loginLocal = useCallback(
    (username: string, password: string) =>
      signIn('credentials', {
        username,
        password,
        redirect: false,
        callbackUrl: routes.dashboard,
      }),
    []
  );
  const logout = useCallback(() => signOut({ callbackUrl: routes.login }), []);

  return {
    user,
    isLoading,
    isAuthenticated,
    login,
    loginLocal,
    logout,
    session,
  };
}
