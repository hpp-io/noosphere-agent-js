// API configuration for frontend
function getApiBaseUrl(): string {
  // Server-side: use env var or default
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  }
  // Client-side: use current hostname with API port
  return `${window.location.protocol}//${window.location.hostname}:4000`;
}

export const API_BASE_URL = getApiBaseUrl();

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${getApiBaseUrl()}${path}`;
  return fetch(url, {
    ...options,
    credentials: 'include',
  });
}
