'use client';

import { useEffect, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { usePlayer } from '@/hooks/use-player';
import { logger } from '@/lib/logger';

/** Restore the account default and serialize explicit speed changes into its session. */
export function usePlaybackSpeedSession() {
  const { data: session, status, update } = useSession();
  const pending = useRef(0);
  const restoredUser = useRef<string | undefined>();
  const updateRef = useRef(update);
  updateRef.current = update;
  const userId = session?.user.id;
  const savedSpeed = session?.playbackSpeed ?? 1;

  useEffect(() => {
    if (status === 'loading') return;
    if (restoredUser.current === userId && pending.current > 0) return;
    restoredUser.current = userId;
    usePlayer.setState({ speed: userId ? savedSpeed : 1 });
  }, [status, userId, savedSpeed]);

  useEffect(() => {
    if (!userId) return;
    let active = true;
    let queue = Promise.resolve();
    pending.current = 0;
    const unsubscribe = usePlayer.subscribe((state, previous) => {
      if (state.speedChangeVersion === previous.speedChangeVersion) return;
      const playbackSpeed = state.speed;
      pending.current += 1;
      queue = queue.then(async () => {
        if (!active) return;
        try {
          const result = await updateRef.current({ playbackSpeed });
          if (!result) throw new Error('Session update failed');
        } catch (error) {
          logger.player.error('Unable to save playback speed', error);
        } finally {
          if (active) pending.current -= 1;
        }
      });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [userId]);
}
