'use client';

import { Button } from '@/components/ui/button';
import { Loader2, Save, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';

interface StickySaveBarProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  error?: string | null;
}

export function StickySaveBar({ dirty, saving, onSave, onReset, error }: StickySaveBarProps) {
  return (
    <div className="sticky bottom-4 z-10">
      <div
        className={cn(
          'flex flex-col gap-3 rounded-lg border border-border bg-card/95 p-4 shadow-lg backdrop-blur sm:flex-row sm:items-center sm:justify-between',
          !dirty && 'opacity-90'
        )}
      >
        <div className="flex items-center gap-2 text-sm">
          <span
            className={cn(
              'h-2 w-2 rounded-full',
              dirty ? 'bg-yellow-500' : 'bg-green-500'
            )}
            aria-hidden
          />
          <span className="text-muted-foreground">
            {dirty ? 'You have unsaved changes' : 'All changes saved'}
          </span>
          {error ? (
            <span role="alert" className="text-sm text-destructive">
              {error}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={onReset} disabled={!dirty || saving}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset
          </Button>
          <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
            {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
            {saving ? 'Saving...' : 'Save Settings'}
          </Button>
        </div>
      </div>
    </div>
  );
}
