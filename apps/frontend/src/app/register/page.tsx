'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { BookOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { fetchAuthApi, getSetupStatus } from '@/lib/auth-api';
import { routes } from '@/lib/routes';

export default function RegisterPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [checkingSetup, setCheckingSetup] = useState(true);

  useEffect(() => {
    const checkSetupStatus = async () => {
      try {
        const data = await getSetupStatus();
        if (!data.needs_setup) {
          router.replace(routes.login);
        }
      } catch (err) {
        setError('Unable to check setup status');
      } finally {
        setCheckingSetup(false);
      }
    };
    
    checkSetupStatus();
  }, [router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    
    setSubmitting(true);
    
    try {
      const response = await fetchAuthApi('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
        }),
      });
      
      if (!response.ok) {
        const errorData = await response.json();
        setError(errorData.detail || 'Registration failed');
        setSubmitting(false);
        return;
      }
      
      const loginResult = await signIn('credentials', {
        username,
        password,
        redirect: false,
        callbackUrl: routes.dashboard,
      });
      
      if (loginResult?.ok) {
        router.replace(routes.dashboard);
      } else {
        setError('Registration successful but login failed. Please contact support.');
      }
    } catch (err) {
      setError('Network error during registration');
    }
    
    setSubmitting(false);
  };

  if (checkingSetup) {
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
          <h2 className="text-center text-xl font-semibold text-foreground">Set Up Administrator</h2>
          
          <p className="text-sm text-muted-foreground text-center">
            Create the first server account. This account will be the administrator.
          </p>

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
                placeholder="Create a password"
                required
              />
            </div>
            
            <div className="space-y-2">
              <label htmlFor="confirmPassword" className="text-sm font-medium text-foreground">
                Confirm Password
              </label>
              <Input
                id="confirmPassword"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm your password"
                required
              />
            </div>

            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <Button
              type="submit"
              disabled={submitting || false}
              className="w-full"
              size="lg"
            >
              {submitting ? (
                <div className="h-5 w-5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                'Create Administrator'
              )}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
