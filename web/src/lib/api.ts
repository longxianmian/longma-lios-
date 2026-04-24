import { getAuth } from './auth';

async function request(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<unknown> {
  const auth = getAuth();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (auth?.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  }

  let url = path;
  if (params && Object.keys(params).length > 0) {
    const qs = new URLSearchParams(params).toString();
    url = `${path}?${qs}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const data = await res.json() as { message?: string; error?: string };
      message = data.message ?? data.error ?? message;
    } catch {
      // ignore parse error
    }
    throw new Error(message);
  }

  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text) as unknown;
}

export const api = {
  get(path: string, params?: Record<string, string>): Promise<unknown> {
    return request('GET', path, undefined, params);
  },
  post(path: string, body: unknown): Promise<unknown> {
    return request('POST', path, body);
  },
  put(path: string, body: unknown): Promise<unknown> {
    return request('PUT', path, body);
  },
};
