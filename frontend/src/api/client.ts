import { zhApiError } from '../utils/locale';

const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

function headers(): HeadersInit {
  const token = localStorage.getItem('auth_token');
  return token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

const API_TIMEOUT_MS = 45_000;

export type ApiOptions = RequestInit & { timeoutMs?: number };

export async function api<T>(path: string, init?: ApiOptions): Promise<T> {
  const { timeoutMs = API_TIMEOUT_MS, ...fetchInit } = init ?? {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...fetchInit,
      signal: controller.signal,
      headers: { ...headers(), ...fetchInit.headers },
    });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error('后端响应超时，请稍后重试');
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let json: { ok?: boolean; error?: string; data?: T };
  try {
    json = (await res.json()) as { ok?: boolean; error?: string; data?: T };
  } catch {
    if (res.status === 504) {
      throw new Error('后端响应超时（504），请稍后刷新或检查 API 服务');
    }
    throw new Error(`HTTP ${res.status}：无法解析响应`);
  }
  if (!res.ok || !json.ok) {
    throw new Error(zhApiError(String(json.error ?? `HTTP ${res.status}`)));
  }
  return json.data as T;
}

export function apiRaw(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, { ...init, headers: { ...headers(), ...init?.headers } });
}
