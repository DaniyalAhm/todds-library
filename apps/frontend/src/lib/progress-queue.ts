export interface ProgressSnapshot {
  bookId: string;
  progress: number;
  position: number;
  location?: string | null;
}

const DB_NAME = 'todds-library';
const STORE = 'progress-queue';
const SYNC_TAG = 'save-progress';

export function isSyncSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'sync' in ServiceWorkerRegistration.prototype
  );
}

function openQueue(): Promise<IDBDatabase> {
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

/**
 * Queue the latest progress for delivery via Background Sync. Only the most
 * recent position per book is kept (progress is idempotent, latest wins).
 * Resolves `true` when the save was queued for Background Sync; `false` when
 * Background Sync is unavailable and the caller must fall back to a direct
 * keepalive save.
 */
export async function enqueueProgress(entry: ProgressSnapshot): Promise<boolean> {
  if (!isSyncSupported()) return false;
  try {
    const db = await openQueue();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    const registration = await navigator.serviceWorker.ready;
    const syncManager = (
      registration as unknown as { sync: { register(tag: string): Promise<void> } }
    ).sync;
    await syncManager.register(SYNC_TAG);
    return true;
  } catch {
    return false;
  }
}

export async function clearProgress(bookId: string): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openQueue();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(bookId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    // Ignore; the entry will be replayed and coalesced by a later sync.
  }
}