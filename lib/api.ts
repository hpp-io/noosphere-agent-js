// API configuration for frontend
export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${API_BASE_URL}${path}`;
  return fetch(url, {
    ...options,
    credentials: 'include',
  });
}
