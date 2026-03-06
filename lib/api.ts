// API configuration for frontend
// Uses relative "/api" path so requests go through the Next.js API route proxy.
// This ensures correct routing regardless of external port mapping.
function getApiBaseUrl(): string {
  if (typeof window === 'undefined') {
    // Server-side: direct connection to API server
    return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
  }
  // Client-side: proxy through Next.js API route
  return '';
}

export const API_BASE_URL = getApiBaseUrl();

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${getApiBaseUrl()}${path}`;
  return fetch(url, {
    ...options,
    credentials: 'include',
  });
}
