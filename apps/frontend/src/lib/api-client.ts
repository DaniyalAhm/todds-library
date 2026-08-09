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
let refreshInFlight: Promise<boolean> | null = null;
const TOKEN_WAIT_TIMEOUT_MS = 5000;

export function setAuthSession(access: string | null, session: string | null) {
  accessToken = access;
  authSessionToken = session;
  tokenKnown = true;
  const pending = tokenWaiters;
  tokenWaiters = [];
  pending.forEach((resolve) => resolve());
}

export function setSessionToken(token: string | null) {
  setAuthSession(token, authSessionToken);
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

async function refreshSession(): Promise<boolean> {
  if (!authSessionToken) return false;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    try {
      const response = await fetch(buildApiUrl('/auth/refresh').toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_token: authSessionToken }),
      });
      if (!response.ok) return false;
      const data = (await response.json()) as {
        access_token?: unknown;
        session_token?: unknown;
      };
      if (typeof data.access_token !== 'string') return false;
      accessToken = data.access_token;
      if (typeof data.session_token === 'string') {
        authSessionToken = data.session_token;
      }
      return true;
    } catch {
      return false;
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

  const doFetch = () =>
    fetch(url.toString(), {
      method,
      headers,
      body:
        body instanceof FormData
          ? body
          : body !== undefined
            ? JSON.stringify(body)
            : undefined,
      signal: config?.signal,
    });

  let response = await doFetch();

  if (response.status === 401) {
    const refreshed = await refreshSession();
    if (refreshed) {
      headers['Authorization'] = `Bearer ${accessToken}`;
      response = await doFetch();
    } else {
      unauthorizedHandler?.();
    }
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
