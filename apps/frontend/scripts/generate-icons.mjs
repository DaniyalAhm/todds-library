#!/usr/bin/env node
/**
 * Generate PWA PNG icons from public/icons/icon.svg.
 * Uses `sharp` if available, otherwise falls back to copying the SVG
 * and emitting placeholder PNGs so `next build` never fails (the SVG is
 * still usable as an icon; Chrome will scale it). Run in `prebuild`.
 */
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const svgPath = resolve(root, 'public/icons/icon.svg');
const publicDir = resolve(root, 'public');
const iconsDir = resolve(publicDir, 'icons');

const targets = [
  { file: resolve(publicDir, 'icon-192.png'), size: 192 },
  { file: resolve(publicDir, 'icon-512.png'), size: 512 },
  { file: resolve(publicDir, 'icon-maskable-512.png'), size: 512, maskable: true },
  { file: resolve(publicDir, 'apple-touch-icon.png'), size: 180 },
];

async function withSharp() {
  const { default: sharp } = await import('sharp');
  if (!existsSync(svgPath)) {
    console.warn('[generate-icons] SVG not found at', svgPath);
    return false;
  }
  const svgBuffer = readFileSync(svgPath);
  for (const { file, size } of targets) {
    // For maskable, add 16% safe-zone padding (approx 80px on 512)
    const isMaskable = file.includes('maskable');
    const padding = isMaskable ? Math.round(size * 0.16) : 0;
    const inner = size - padding * 2;
    // Create a solid canvas then composite resized SVG centered
    const canvas = sharp({
      create: { width: size, height: size, channels: 4, background: '#0f172a' },
    }).png();
    // Rounded rect mask is handled by SVG itself; for maskable we keep square
    const resizedSvg = await sharp(svgBuffer).resize(inner, inner).png().toBuffer();
    await canvas
      .composite([{ input: resizedSvg, left: padding, top: padding }])
      .png()
      .toFile(file);
    console.log(`[generate-icons] wrote ${file} (${size}x${size})`);
  }
  return true;
}

async function fallback() {
  // Ensure icons dir exists
  mkdirSync(iconsDir, { recursive: true });
  // Minimal 1x1 transparent PNG (base64) used as placeholder so the build
  // has valid PNG files even when sharp is not installed. Browsers will still
  // show the SVG; this just satisfies the manifest's PNG references.
  const placeholderB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';
  const placeholder = Buffer.from(placeholderB64, 'base64');
  for (const { file } of targets) {
    if (!existsSync(file)) {
      // Prefer copying SVG as fallback so icon is visible in dev even without sharp
      // For PNG targets we write the placeholder PNG
      writeFileSync(file, placeholder);
      console.log(`[generate-icons] (fallback) wrote placeholder ${file} — install "sharp" for crisp icons: npm i -D sharp && node scripts/generate-icons.mjs`);
    }
  }
}

try {
  const ok = await withSharp();
  if (!ok) await fallback();
} catch (err) {
  console.warn('[generate-icons] sharp not available or failed:', err?.message ?? err);
  await fallback();
}
