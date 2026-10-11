'use client';

import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { errorMessage } from './constants';

interface BulkJobCardProps {
  icon: ReactNode;
  title: string;
  description: string;
  hint: string;
  actionLabel: ReactNode;
  runningLabel?: string;
  pending: boolean;
  isSuccess: boolean;
  successMessage: string;
  error: unknown;
  isError: boolean;
  running: boolean;
  stopPending?: boolean;
  stopLabel?: ReactNode;
  onStart: () => void;
  onStop?: () => void;
}

export function BulkJobCard({ icon, title, description, hint, actionLabel, runningLabel = 'Starting...', pending, isSuccess, successMessage, error, isError, running, stopPending, stopLabel, onStart, onStop }: BulkJobCardProps) {
  const showStop = running && onStop && stopLabel;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          {icon}
          <CardTitle>{title}</CardTitle>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {showStop ? (
          <Button variant="destructive" onClick={onStop} disabled={stopPending}>
            {stopPending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Stopping...
              </>
            ) : (
              stopLabel
            )}
          </Button>
        ) : pending ? (
          <Button variant="outline" disabled>
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            {runningLabel}
          </Button>
        ) : (
          <Button onClick={onStart} disabled={pending}>
            {actionLabel}
          </Button>
        )}
        {isSuccess && <p className="mt-2 text-sm text-green-600">{successMessage}</p>}
        {isError && <p className="mt-2 text-sm text-red-600">{errorMessage(error, 'Failed to start.')}</p>}
        <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
