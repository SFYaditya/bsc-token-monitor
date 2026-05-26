import { api } from '../api/client';
import { cachedFetch } from '../utils/requestCache';

const HOLDER_DEFAULT =
  'filter=all&pageSize=200&sort=balance&order=desc';

export function overviewCacheKey(addr: string): string {
  return `overview:${addr.toLowerCase()}`;
}

export function holderRankingCacheKey(addr: string, query = HOLDER_DEFAULT): string {
  return `holders:${addr.toLowerCase()}:${query}`;
}

export function chartCacheKey(addr: string, range: string): string {
  return `chart:${addr.toLowerCase()}:${range}`;
}

export async function prefetchTokenBundle(addr: string, range = '24h'): Promise<void> {
  const a = addr.toLowerCase();
  await Promise.allSettled([
    cachedFetch(overviewCacheKey(a), () =>
      api<{ contract: Record<string, unknown>; overview: Record<string, unknown> }>(
        `/api/v1/tokens/${a}/overview`,
      ),
    ),
    cachedFetch(holderRankingCacheKey(a), () =>
      api<{ items: unknown[] }>(
        `/api/v1/tokens/${a}/holder-ranking?${HOLDER_DEFAULT}`,
      ),
    ),
    cachedFetch(chartCacheKey(a, range), () =>
      api<{ price: unknown[]; volume: unknown[] }>(
        `/api/v1/tokens/${a}/chart?range=${range}`,
      ),
    ),
  ]);
}

export function prefetchTokenBundles(addrs: string[], range = '24h'): void {
  const unique = [...new Set(addrs.map((x) => x.toLowerCase()).filter(Boolean))];
  for (const a of unique) {
    void prefetchTokenBundle(a, range);
  }
}
