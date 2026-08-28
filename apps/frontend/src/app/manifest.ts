import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Todd's Library",
    short_name: "Todds Library",
    description: 'Your personal ebook and audiobook library',
    id: '/',
    start_url: '/',
    display: 'standalone',
    display_override: ['window-controls-overlay', 'standalone', 'browser'],
    background_color: '#0f172a',
    theme_color: '#0f172a',
    orientation: 'any',
    scope: '/',
    icons: [
      {
        src: '/icons/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    shortcuts: [
      {
        name: 'Search',
        url: '/search',
        description: 'Search your library',
      },
      {
        name: 'Libraries',
        url: '/libraries',
        description: 'Browse libraries',
      },
    ],
    categories: ['books', 'entertainment', 'media'],
  };
}
