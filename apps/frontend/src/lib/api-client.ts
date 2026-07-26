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

let sessionToken: string | null = null;

export function setSessionToken(token: string | null) {
  sessionToken = token;
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

  if (sessionToken) {
    headers['Authorization'] = `Bearer ${sessionToken}`;
  }

  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url.toString(), {
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
