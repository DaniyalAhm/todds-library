type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

interface ApiError {
  status: number;
  message: string;
  details?: Record<string, string[]>;
}

interface RequestConfig {
  params?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

let accessToken: string | null = null;
let authSessionToken: string | null = null;
let tokenKnown = false;
let tokenWaiters: Array<() => void> = [];
let unauthorizedHandler: (() => void) | null = null;
let refreshInFlight: Promise<RefreshOutcome> | null = null;
let accessTokenListeners: Array<(access: string | null) => void> = [];
const TOKEN_WAIT_TIMEOUT_MS = 5000;
const REFRESH_RETRIES = 2;
const REFRESH_RETRY_DELAY_MS = 750;
const REQUEST_TIMEOUT_MS = 20_000;
const REFRESH_TIMEOUT_MS = 15_000;
const NETWORK_RETRIES = 2;
const NETWORK_RETRY_DELAY_MS = 500;

class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out');
    this.name = 'RequestTimeoutError';
  }
}

// Wrap fetch with a timeout. A connection wedged by a backgrounded mobile tab
// would otherwise hang the app indefinitely. The caller's signal (if any) is
// combined with an internal timer so both can abort.
function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new RequestTimeoutError()), timeoutMs);
  const external = init.signal;

  if (external) {
    if (external.aborted) {
      clearTimeout(timer);
      throw external.reason ?? new DOMException('The operation was aborted.', 'AbortError');
    }
    const onExternalAbort = () =>
      controller.abort(external.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    external.addEventListener('abort', onExternalAbort, { once: true });
    return fetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      external.removeEventListener('abort', onExternalAbort);
    });
  }

  return fetch(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

function isTransientNetworkError(error: unknown): boolean {
  if (error instanceof RequestTimeoutError) return true;
  // A caller-initiated abort is not transient — rethrow it unchanged.
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  // fetch rejects with TypeError on connection failures.
  if (error instanceof TypeError) return true;
  return false;
}

function notifyAccessTokenListeners() {
  accessTokenListeners.forEach((listener) => {
    try {
      listener(accessToken);
    } catch {
      // A failing listener must not break token sync.
    }
  });
}

export function setAuthSession(access: string | null, session: string | null) {
  accessToken = access;
  authSessionToken = session;
  tokenKnown = true;
  const pending = tokenWaiters;
  tokenWaiters = [];
  pending.forEach((resolve) => resolve());
  notifyAccessTokenListeners();
}

export function setSessionToken(token: string | null) {
  setAuthSession(accessToken, token);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getSessionToken(): string | null {
  return authSessionToken;
}

export function subscribeAccessToken(listener: (access: string | null) => void): () => void {
  accessTokenListeners.push(listener);
  if (tokenKnown) {
    listener(accessToken);
  }
  return () => {
    accessTokenListeners = accessTokenListeners.filter((entry) => entry !== listener);
  };
}

export function setUnauthorizedHandler(handler: (() => void) | null) {
  unauthorizedHandler = handler;
}

async function awaitSessionToken(): Promise<void> {
  if (tokenKnown) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      tokenWaiters = tokenWaiters.filter((waiter) => waiter !== finish);
      resolve();
    };
    const timer = setTimeout(finish, TOKEN_WAIT_TIMEOUT_MS);
    tokenWaiters.push(finish);
  });
}

export function getAuthHeaders(): Record<string, string> {
  if (accessToken) {
    return { 'Authorization': `Bearer ${accessToken}` };
  }
  return {};
}

export type RefreshOutcome = 'refreshed' | 'invalid' | 'failed';

async function performRefresh(): Promise<RefreshOutcome> {
  if (!authSessionToken) return 'invalid';
  try {
    const response = await fetchWithTimeout(
      buildApiUrl('/auth/refresh').toString(),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: authSessionToken }),
      },
      REFRESH_TIMEOUT_MS
    );
    if (response.ok) {
      const data = (await response.json()) as {
        access_token?: unknown;
        session_token?: unknown;
      };
      if (typeof data.access_token !== 'string') return 'failed';
      accessToken = data.access_token;
      if (typeof data.session_token === 'string') {
        authSessionToken = data.session_token;
      }
      notifyAccessTokenListeners();
      return 'refreshed';
    }
    // An explicit 401/403 means the session is genuinely gone.
    if (response.status === 401 || response.status === 403) {
      return 'invalid';
    }
    // 5xx / proxy errors are transient — retry rather than logging out.
    return 'failed';
  } catch {
    // Network errors (e.g. a backgrounded/throttled mobile tab) are transient.
    return 'failed';
  }
}

export async function refreshAuthSession(): Promise<RefreshOutcome> {
  if (!authSessionToken) return 'invalid';
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      for (let attempt = 0; attempt <= REFRESH_RETRIES; attempt += 1) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS * attempt));
        }
        const outcome = await performRefresh();
        if (outcome !== 'failed') return outcome;
      }
      return 'failed';
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

function getBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL || '/backend-api';
  if (typeof window !== 'undefined' && configured.startsWith('http')) {
    const configuredUrl = new URL(configured);
    const isLoopbackApi =
      configuredUrl.hostname === 'localhost' || configuredUrl.hostname === '127.0.0.1';

    if (isLoopbackApi && configuredUrl.port !== window.location.port) {
      return `${window.location.origin}/backend-api`;
    }
  }
  if (configured.startsWith('http')) {
    return configured;
  }
  if (typeof window !== 'undefined') {
    return `${window.location.origin}${configured}`;
  }
  return `http://localhost:3000${configured}`;
}

function buildApiUrl(path: string): URL {
  const base = getBaseUrl().replace(/\/+$/, '');
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return new URL(`${base}${normalizedPath}`);
}

export function getApiUrl(path: string): string {
  return buildApiUrl(path).toString();
}

export function postProgressWithKeepalive(
  bookId: string,
  data: { progress: number; position: number; location?: string | null }
) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }
  void fetch(buildApiUrl(`/books/${bookId}/progress`).toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(data),
    keepalive: true,
  });
}

async function doRequestOnce<T>(
  method: HttpMethod,
  url: URL,
  headers: Record<string, string>,
  body: unknown,
  config?: RequestConfig
): Promise<T> {
  const doFetch = () =>
    fetchWithTimeout(
      url.toString(),
      {
        method,
        headers,
        body:
          body instanceof FormData
            ? body
            : body !== undefined
              ? JSON.stringify(body)
              : undefined,
        signal: config?.signal,
      },
      REQUEST_TIMEOUT_MS
    );

  let response = await doFetch();

  if (response.status === 401) {
    const outcome = await refreshAuthSession();
    if (outcome === 'refreshed') {
      headers['Authorization'] = `Bearer ${accessToken}`;
      response = await doFetch();
    } else if (outcome === 'invalid') {
      unauthorizedHandler?.();
    }
    // outcome === 'failed' (transient network error) — fall through and
    // surface the request error without logging the user out.
  }

  if (!response.ok) {
    let errorData: ApiError;
    try {
      const data = await response.json();
      errorData = {
        status: response.status,
        message: data.detail || data.message || response.statusText,
        details: data.errors,
      };
    } catch {
      errorData = {
        status: response.status,
        message: response.statusText,
      };
    }
    throw errorData;
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

async function request<T>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  config?: RequestConfig
): Promise<T> {
  await awaitSessionToken();
  const url = buildApiUrl(path);

  if (config?.params) {
    Object.entries(config.params).forEach(([key, value]) => {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const headers: Record<string, string> = {
    ...config?.headers,
  };

  if (accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  // Retry transient network failures/timeouts on fresh connections — a dead
  // keep-alive socket from a backgrounded mobile tab should not kill the app.
  let lastError: unknown;
  for (let attempt = 0; attempt <= NETWORK_RETRIES; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_DELAY_MS * attempt));
    }
    try {
      return await doRequestOnce<T>(method, url, headers, body, config);
    } catch (error) {
      if (isTransientNetworkError(error)) {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export const api = {
  get<T>(path: string, config?: RequestConfig): Promise<T> {
    return request<T>('GET', path, undefined, config);
  },
  post<T>(path: string, body?: unknown, config?: RequestConfig): Promise<T> {
    return request<T>('POST', path, body, config);
  },
  put<T>(path: string, body?: unknown, config?: RequestConfig): Promise<T> {
    return request<T>('PUT', path, body, config);
  },
  patch<T>(path: string, body?: unknown, config?: RequestConfig): Promise<T> {
    return request<T>('PATCH', path, body, config);
  },
  delete<T>(path: string, config?: RequestConfig): Promise<T> {
    return request<T>('DELETE', path, undefined, config);
  },
};
