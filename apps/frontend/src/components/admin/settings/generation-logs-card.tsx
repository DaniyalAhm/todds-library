'use client';

import { useEffect, useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollText } from 'lucide-react';
import type { GenerationLogEntry } from '@/hooks/use-settings';

function LogBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    started: { label: 'Started', cls: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200' },
    progress: { label: 'Progress', cls: 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200' },
    completed: { label: 'Completed', cls: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200' },
    failed: { label: 'Failed', cls: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200' },
    skipped: { label: 'Skipped', cls: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200' },
    cancelled: { label: 'Cancelled', cls: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200' },
  };
  const entry = map[status] || { label: status, cls: 'bg-gray-100 text-gray-800' };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${entry.cls}`}>{entry.label}</span>;
}

interface GenerationLogsCardProps {
  logs: GenerationLogEntry[];
}

export function GenerationLogsCard({ logs }: GenerationLogsCardProps) {
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const latest = logs.length ? logs[logs.length - 1] : null;
  const latestLabel = latest?.created_at ? new Date(latest.created_at).toLocaleString() : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <ScrollText className="h-5 w-5 text-primary" />
          <CardTitle>Generation Logs</CardTitle>
        </div>
        <CardDescription>Live feed of subtitle generation activity</CardDescription>
      </CardHeader>
      <CardContent>
        {latestLabel && (
          <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>Last update</span>
            <span>{latestLabel}</span>
          </div>
        )}
        <div className="max-h-80 space-y-1 overflow-y-auto rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
          {logs.length === 0 && <p className="p-2 text-muted-foreground">No generation activity yet.</p>}
          {logs.map((entry) => (
            <div key={entry.id} className="flex items-start gap-2 rounded p-1.5 hover:bg-muted/50">
              <span className="w-16 shrink-0 truncate text-muted-foreground">
                {entry.created_at ? new Date(entry.created_at).toLocaleTimeString() : ''}
              </span>
              <LogBadge status={entry.status} />
              <span className="truncate text-foreground">
                {entry.book_title ? `${entry.book_title}${entry.chapter_index != null ? ` — Ch ${entry.chapter_index}` : ''}` : entry.book_id || ''}
              </span>
              <span className="truncate text-muted-foreground">{entry.message}</span>
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      </CardContent>
    </Card>
  );
}
