import { NextRequest, NextResponse } from 'next/server';

// ANSI colors matching backend Rich categories
const CATEGORY_COLOR: Record<string, string> = {
  HLS: '\x1b[36;1m', // cyan
  FS: '\x1b[35;1m', // magenta
  PLAYER: '\x1b[33;1m', // yellow/orange
  AUTH: '\x1b[34;1m', // blue
  SCANNER: '\x1b[93;1m', // bright yellow
  LIBRARY: '\x1b[96;1m', // bright cyan
  ASR: '\x1b[95;1m', // bright magenta
};

const LEVEL_COLOR: Record<string, string> = {
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
  debug: '\x1b[90m', // gray
};

const RESET = '\x1b[0m';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.message !== 'string') {
      return NextResponse.json({ ok: false }, { status: 400 });
    }
    const category: string = (body.category || 'CLIENT').toUpperCase();
    const level: string = (body.level || 'info').toLowerCase();
    const message: string = body.message;

    const catColor = CATEGORY_COLOR[category] || '\x1b[37;1m';
    const lvlColor = LEVEL_COLOR[level] || LEVEL_COLOR.info;
    const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm

    // This console.log goes to docker logs frontend (stdout)
    // eslint-disable-next-line no-console
    console.log(`${lvlColor}[${timestamp}]${RESET} ${catColor}[${category}]${RESET} ${lvlColor}${level.toUpperCase()}${RESET} ${message}`);

    // Also log user-agent for debugging iPad vs desktop fullscreen
    const ua = request.headers.get('user-agent')?.slice(0, 120) || '';
    if (ua) {
      // eslint-disable-next-line no-console
      console.log(`\x1b[90m  ↳ UA: ${ua}${RESET}`);
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('\x1b[31m[LOGS] failed to process log beacon\x1b[0m', e);
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function GET() {
  return NextResponse.json({ ok: true, message: 'POST {category, level, message} to log with colors' });
}
