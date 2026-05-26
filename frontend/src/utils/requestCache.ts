type Entry<T> = { data: T; at: number };

const store = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const FETCH_TIMEOUT_MS = 45_000;

export function peekCache<T>(key: string, maxAgeMs = Infinity): T | undefined {
  const hit = store.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > maxAgeMs) return undefined;
  return hit.data as T;
}

export function setCache<T>(key: string, data: T): void {
  store.set(key, { data, at: Date.now() });
}

export function invalidateCache(prefix?: string): void {
  if (!prefix) {
    store.clear();
    return;
  }
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key);
  }
}

/** 去重 + 内存缓存；有缓存时先返回缓存，后台仍可用 revalidate 刷新 */
export async function cachedFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs = 60_000,
): Promise<T> {
  const hit = peekCache<T>(key, ttlMs);
  if (hit !== undefined) return hit;

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const p = Promise.race([
    fetcher(),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('请求超时')), FETCH_TIMEOUT_MS);
    }),
  ])
    .then((data) => {
      setCache(key, data);
      inflight.delete(key);
      return data;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, p);
  return p as Promise<T>;
}

/** 先展示缓存，再静默刷新（用于代币切换） */
export async function fetchWithStale<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttlMs: number,
  onStale?: (data: T) => void,
): Promise<T> {
  const stale = peekCache<T>(key, ttlMs);
  if (stale !== undefined) onStale?.(stale);

  const freshTtl = 15_000;
  const fresh = peekCache<T>(key, freshTtl);
  if (fresh !== undefined) return fresh;

  return cachedFetch(key, fetcher, ttlMs);
}
