import { api, captureProgress, getAuthUserId } from '@/lib/api-client';

export interface ProgressSnapshot {
  bookId: string;
  progress: number;
  position: number;
  location?: string | null;
  expected_user_id?: string | null;
  captured_at?: number;
}

const DB_NAME = 'todds-library';
const STORE = 'progress-queue-v2';
const SYNC_TAG = 'save-progress';
let replaying = false;

export function isSyncSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'ServiceWorkerRegistration' in window && 'sync' in ServiceWorkerRegistration.prototype;
}

function openQueue(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { settled = true; reject(new Error('Progress journal unavailable')); }, 1500);
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Legacy entries have no account identity and cannot be replayed safely.
      if (db.objectStoreNames.contains('progress-queue')) db.deleteObjectStore('progress-queue');
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: ['expected_user_id', 'bookId'] });
    };
    req.onsuccess = () => {
      clearTimeout(timer);
      if (settled) { req.result.close(); return; }
      settled = true;
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => { clearTimeout(timer); settled = true; reject(req.error); };
  });
}

/** Persist the latest snapshot for this user and book, even without Background Sync. */
export async function enqueueProgress(entry: ProgressSnapshot): Promise<boolean> {
  const snapshot = captureProgress(entry);
  if (!snapshot.expected_user_id || typeof indexedDB === 'undefined') return false;
  try {
    const db = await openQueue();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const request = store.get([snapshot.expected_user_id!, snapshot.bookId]);
        request.onsuccess = () => {
          if (!request.result || request.result.captured_at < snapshot.captured_at) store.put(snapshot);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
    if (isSyncSupported()) {
      void navigator.serviceWorker.ready.then((registration) =>
        (registration as unknown as { sync: { register(tag: string): Promise<void> } }).sync.register(SYNC_TAG)
      ).catch(() => {});
    }
    return true;
  } catch { return false; }
}

/** Remove only snapshots acknowledged by the server; retain newer queued positions. */
export async function clearProgress(bookId: string, userId?: string | null, capturedAt?: number): Promise<void> {
  if (!userId || capturedAt === undefined || typeof indexedDB === 'undefined') return;
  try {
    const db = await openQueue();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        const store = tx.objectStore(STORE);
        const key = [userId, bookId];
        const request = store.get(key);
        request.onsuccess = () => {
          if (request.result && request.result.captured_at <= capturedAt) store.delete(key);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } finally { db.close(); }
  } catch { /* Retain the entry for retry. */ }
}

/** Replay only the currently authenticated user's journal, including Safari fallback. */
export async function replayProgressQueue(): Promise<void> {
  const userId = getAuthUserId();
  if (replaying || !userId || typeof indexedDB === 'undefined') return;
  replaying = true;
  try {
    const db = await openQueue();
    let entries: ProgressSnapshot[];
    try {
      entries = await new Promise((resolve, reject) => {
        const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally { db.close(); }
    for (const entry of entries) {
      if (entry.expected_user_id !== userId || getAuthUserId() !== userId) continue;
      try {
        await api.post(`/books/${entry.bookId}/progress`, entry);
        await clearProgress(entry.bookId, userId, entry.captured_at);
      } catch { /* Retry when the network or session recovers. */ }
    }
  } catch { /* IndexedDB may be unavailable. */ }
  finally { replaying = false; }
}
