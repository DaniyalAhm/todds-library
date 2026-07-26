'use client';

import { useAuth } from '@/hooks/use-auth';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSetupStatus } from '@/lib/auth-api';

export default function LoginPage() {
  const { isAuthenticated, isLoading, loginLocal, login } = useAuth();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [hasAuthentik, setHasAuthentik] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);

  useEffect(() => {
    if (isAuthenticated) {
      router.replace('/dashboard');
    }
    
    // Check if Authentik is configured by checking environment variables
    const isAuthentikConfigured = process.env.NEXT_PUBLIC_AUTHENTIK_ISSUER && 
                                process.env.NEXT_PUBLIC_AUTHENTIK_CLIENT_ID && 
                                process.env.NEXT_PUBLIC_AUTHENTIK_CLIENT_SECRET;
    setHasAuthentik(!!isAuthentikConfigured);
  }, [isAuthenticated, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    const result = await loginLocal(username, password);
    if (result?.error) {
      setError('Invalid username or password');
    } else if (result?.ok) {
      router.replace('/dashboard');
    }
    setSubmitting(false);
  };

  useEffect(() => {
    const checkSetupStatus = async () => {
      try {
        const data = await getSetupStatus();
        setNeedsSetup(Boolean(data.needs_setup));
        if (data.needs_setup) {
          router.replace('/register');
        }
      } catch (err) {
        setNeedsSetup(false);
      } finally {
        setCheckingSetup(false);
      }
    };
    
    checkSetupStatus();
  }, [router]);

  if (checkingSetup || needsSetup) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background">
      <div className="mx-auto flex w-full max-w-md flex-col items-center space-y-8 px-4">
        <div className="flex items-center space-x-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-primary">
            <BookOpen className="h-8 w-8 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-3xl font-bold text-foreground">Todd&apos;s Library</h1>
            <p className="text-sm text-muted-foreground">Your personal media library</p>
          </div>
        </div>

        <div className="w-full space-y-4 rounded-lg border border-border bg-card p-8">
          <h2 className="text-center text-xl font-semibold text-foreground">Sign In</h2>

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="username" className="text-sm font-medium text-foreground">
                Username
              </label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                required
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium text-foreground">
                Password
              </label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                required
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button
              type="submit"
              disabled={submitting || isLoading}
              className="w-full"
              size="lg"
            >
              {submitting ? (
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                'Sign In'
              )}
            </Button>
          </form>

          {hasAuthentik && (
            <>
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-border" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-card px-2 text-muted-foreground">Or</span>
                </div>
              </div>
              <Button
                onClick={login}
                disabled={isLoading}
                variant="outline"
                className="w-full"
                size="lg"
              >
                Sign in with Authentik
              </Button>
            </>
          )}
          
          {needsSetup && (
            <div className="pt-4 text-center">
              <a href="/register" className="text-sm text-primary hover:underline">
                Complete server setup
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
