'use client';

type Level = 'info' | 'warn' | 'error' | 'debug';

const CATEGORY_STYLES: Record<string, string> = {
  HLS: 'color:#06b6d4;font-weight:700;background:#0e2a33;padding:2px 6px;border-radius:4px',
  FS: 'color:#d946ef;font-weight:700;background:#2a1033;padding:2px 6px;border-radius:4px',
  PLAYER: 'color:#f59e0b;font-weight:700;background:#33260e;padding:2px 6px;border-radius:4px',
  AUTH: 'color:#3b82f6;font-weight:700;background:#0e1a33;padding:2px 6px;border-radius:4px',
  SCANNER: 'color:#eab308;font-weight:700;background:#332e0e;padding:2px 6px;border-radius:4px',
  LIBRARY: 'color:#22d3ee;font-weight:700;background:#0e2f33;padding:2px 6px;border-radius:4px',
  ASR: 'color:#c084fc;font-weight:700;background:#1e0e33;padding:2px 6px;border-radius:4px',
};

const SERVER_LEVEL_COLOR: Record<string, string> = {
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  debug: '\x1b[90m',
};

// Fire-and-forget POST to Next.js API that writes to docker logs (server console)
function postToServer(category: string, level: Level, args: unknown[]) {
  if (typeof window === 'undefined') return;
  // Avoid logging the logger's own POST
  try {
    const message = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    // Use keepalive so it survives pagehide
    fetch('/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ category, level, message }),
      keepalive: true,
    }).catch(() => {
      // Ignore network errors (offline, not http, etc)
    });
  } catch {}
}

function makeLogger(category: string) {
  const style = CATEGORY_STYLES[category] || 'color:#fff;font-weight:700';
  const invoke = (level: Level, fn: (...a: any[]) => void, args: unknown[]) => {
    // Browser colored console with %c
    fn(`%c[${category}]%c`, style, 'color:inherit', ...args);
    postToServer(category, level, args);
  };
  return {
    info: (...args: unknown[]) => invoke('info', console.log, args),
    log: (...args: unknown[]) => invoke('info', console.log, args),
    warn: (...args: unknown[]) => invoke('warn', console.warn, args),
    error: (...args: unknown[]) => invoke('error', console.error, args),
    debug: (...args: unknown[]) => invoke('debug', console.debug, args),
  };
}

export const logger = {
  hls: makeLogger('HLS'),
  fs: makeLogger('FS'),
  player: makeLogger('PLAYER'),
  auth: makeLogger('AUTH'),
  scanner: makeLogger('SCANNER'),
  library: makeLogger('LIBRARY'),
  asr: makeLogger('ASR'),
};

// Convenience: direct colored print like backend colored_print
export function coloredPrint(category: string, message: string, level: Level = 'info') {
  const l = makeLogger(category.toUpperCase());
  if (level === 'warn') l.warn(message);
  else if (level === 'error') l.error(message);
  else if (level === 'debug') l.debug(message);
  else l.info(message);
}
