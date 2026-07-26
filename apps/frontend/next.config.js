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

module.exports = nextConfig;
