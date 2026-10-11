'use client';

import { useEffect, useRef } from 'react';
import { api, captureProgress, getAuthUserId, postProgressWithKeepalive } from '@/lib/api-client';
import { enqueueProgress, clearProgress } from '@/lib/progress-queue';
import type { ProgressSnapshot } from '@/lib/progress-queue';

export const CONTINUOUS_SYNC_INTERVAL_MS = 500;

/**
 * Continuously POSTs progress snapshots every 500ms while `enabled` is true.
 * Deduplicates unchanged positions and falls back to Background Sync queue on failure.
 */
export function useContinuousProgressSync(
  enabled: boolean,
  getSnapshot: () => ProgressSnapshot | null,
  intervalMs = CONTINUOUS_SYNC_INTERVAL_MS
) {
  const getSnapshotRef = useRef(getSnapshot);
  const enabledRef = useRef(enabled);
  const lastSentRef = useRef<string | null>(null);
  const inFlightRef = useRef(false);

  useEffect(() => {
    getSnapshotRef.current = getSnapshot;
  }, [getSnapshot]);

  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  useEffect(() => {
    if (!enabled) return;

    let owner = getAuthUserId();
    const snapshotForUser = () => {
      const snapshot = getSnapshotRef.current();
      owner ??= getAuthUserId();
      return snapshot && owner ? captureProgress({ ...snapshot, expected_user_id: owner }) : null;
    };
    const flush = () => {
      const snapshot = snapshotForUser();
      if (!snapshot) return;
      postProgressWithKeepalive(snapshot.bookId, snapshot);
      void enqueueProgress(snapshot);
    };

    let intervalId: ReturnType<typeof setInterval> | null = null;
    let visibilityHandler: (() => void) | null = null;

    const tick = async () => {
      if (!enabledRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
      if (inFlightRef.current) return;

      const snapshot = snapshotForUser();
      if (!snapshot || !snapshot.bookId) return;

      // Deduplicate: skip if position/progress/location unchanged
      const key = `${snapshot.expected_user_id}:${snapshot.bookId}:${snapshot.position}:${snapshot.progress}:${snapshot.location ?? ''}`;
      if (lastSentRef.current === key) return;

      inFlightRef.current = true;
      try {
        await enqueueProgress(snapshot);
        await api.post(`/books/${snapshot.bookId}/progress`, snapshot);
        await clearProgress(snapshot.bookId, snapshot.expected_user_id, snapshot.captured_at);
        lastSentRef.current = key;
      } catch {
        // On network failure, queue for Background Sync retry
        try {
          await enqueueProgress(snapshot);
        } catch {
          // ignore queue failure
        }
      } finally {
        inFlightRef.current = false;
      }
    };

    // Start interval
    intervalId = setInterval(tick, intervalMs);

    // Pause/resume on visibility change to save battery
    if (typeof document !== 'undefined') {
      visibilityHandler = () => {
        if (document.visibilityState === 'hidden') flush();
        if (document.visibilityState === 'visible' && enabledRef.current) {
          // immediate tick on becoming visible
          void tick();
        }
      };
      document.addEventListener('visibilitychange', visibilityHandler);
    }

    window.addEventListener('pagehide', flush);

    // Immediate first tick after a short delay to pick up initial state
    const initialTimer = setTimeout(() => void tick(), 500);

    return () => {
      flush();
      window.removeEventListener('pagehide', flush);
      if (intervalId !== null) clearInterval(intervalId);
      clearTimeout(initialTimer);
      if (visibilityHandler) {
        document.removeEventListener('visibilitychange', visibilityHandler);
      }
    };
  }, [enabled, intervalMs]);
}
