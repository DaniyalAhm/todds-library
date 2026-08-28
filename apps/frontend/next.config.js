/** @type {import('next').NextConfig} */
const publicApiUrl = process.env.NEXT_PUBLIC_API_URL || '/backend-api';
const remotePatterns = publicApiUrl.startsWith('http')
  ? [
      {
        protocol: publicApiUrl.startsWith('https') ? 'https' : 'http',
        hostname: new URL(publicApiUrl).hostname,
        port: new URL(publicApiUrl).port,
        pathname: '/**',
      },
    ]
  : [];

const nextConfig = {
  output: 'standalone',
  experimental: {
    outputFileTracingRoot: '../../',
  },
  images: {
    remotePatterns,
  },
  transpilePackages: ['@todds-library/shared-types'],
  async rewrites() {
    return {
      afterFiles: [
        {
          source: '/backend-api/:path*',
          destination: 'http://backend:8000/api/:path*',
        },
      ],
    };
  },
};

// PWA: wrap with @ducanh2912/next-pwa when installed (App Router + standalone
// compatible). We keep a hand-rolled `public/sw.js` for Background Sync, so
// next-pwa is optional — if it is not installed or it breaks the standalone
// build, we fall back to the manual SW + manifest (still satisfies Chrome A2HS).
let exportedConfig = nextConfig;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const withPWA = require('@ducanh2912/next-pwa').default({
    dest: 'public',
    // Never cache media or API — audio streams and /backend-api are network-only.
    // The precached build shell is still available offline for the app chrome.
    workboxOptions: {
      disableDevLogs: true,
      runtimeCaching: [
        {
          urlPattern: /^.*\/backend-api\/.*$/,
          handler: 'NetworkOnly',
        },
        {
          urlPattern: /^.*\/audiobooks\/.*\/(download|stream)(\/.*)?$/,
          handler: 'NetworkOnly',
        },
        {
          urlPattern: /^.*\.(?:ts|m3u8)$/,
          handler: 'NetworkOnly',
        },
      ],
    },
    // Register only in production; dev keeps HMR fast and avoids SW cache confusion.
    disable: process.env.NODE_ENV !== 'production',
    // Keep our custom Background Sync SW intact — next-pwa will extend, not replace.
    // If build breaks with standalone, set NEXT_PWA_DISABLE=1 and rely on hand-rolled sw.js.
    register: false,
    sw: 'sw.js',
  });
  if (!process.env.NEXT_PWA_DISABLE) {
    exportedConfig = withPWA(nextConfig);
  }
} catch {
  // @ducanh2912/next-pwa not installed — manual PWA (manifest + public/sw.js) still works.
}

module.exports = exportedConfig;
