const DB_NAME = 'todds-library';
const STORE = 'progress-queue';
const SYNC_TAG = 'save-progress';

let running = false;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Never cache media or API — audio streams and /backend-api are network-only.
// This ensures the app shell can be precached (when next-pwa is enabled) while
// HLS segments / download streams always hit the network with fresh tokens.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    url.pathname.startsWith('/backend-api/') ||
    url.pathname.includes('/audiobooks/') ||
    url.pathname.endsWith('.ts') ||
    url.pathname.endsWith('.m3u8')
  ) {
    // Network-only: bypass any cache, just fetch.
    return;
  }
  // For all other requests, let the browser handle normally (or Workbox when present).
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'TRIGGER_SYNC') {
    event.waitUntil(runSync());
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    event.waitUntil(runSync());
  }
});

function openQueue() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'bookId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAllEntries(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function deleteEntry(db, bookId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(bookId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAccessToken() {
  try {
    const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
    if (!res.ok) return null;
    const session = await res.json();
    return session && session.accessToken ? session.accessToken : null;
  } catch {
    return null;
  }
}

async function runSync() {
  if (running) return;
  running = true;
  try {
    let db;
    try {
      db = await openQueue();
    } catch {
      return;
    }
    let entries;
    try {
      entries = await getAllEntries(db);
    } catch {
      return;
    }
    if (!entries || entries.length === 0) return;

    const token = await getAccessToken();
    if (!token) return;

    for (const entry of entries) {
      try {
        const res = await fetch(
          `${self.location.origin}/backend-api/books/${encodeURIComponent(entry.bookId)}/progress`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({
              progress: entry.progress,
              position: entry.position,
              location: entry.location ?? null,
            }),
          }
        );
        if (res.ok) {
          await deleteEntry(db, entry.bookId);
        }
      } catch {
        // Keep the entry; a later sync will retry it.
      }
    }
  } finally {
    running = false;
  }
}