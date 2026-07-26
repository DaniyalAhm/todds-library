const FALLBACK_API_BASE = '/backend-api';

function configuredApiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || FALLBACK_API_BASE;
}

function apiUrl(base: string, path: string): string {
  const normalizedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedBase}${normalizedPath}`;
}

function apiBases(): string[] {
  return Array.from(new Set([configuredApiBase(), FALLBACK_API_BASE]));
}

export async function fetchAuthApi(path: string, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  let lastResponse: Response | null = null;

  for (const base of apiBases()) {
    try {
      const response = await fetch(apiUrl(base, path), init);
      if (response.ok || ![404, 502, 503, 504].includes(response.status)) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw lastError;
}

export async function getSetupStatus(): Promise<{ needs_setup: boolean }> {
  const response = await fetchAuthApi('/auth/setup/status');
  if (!response.ok) {
    throw new Error('Unable to check setup status');
  }
  return response.json();
}
