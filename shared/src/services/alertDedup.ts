import { getRedis } from '../cache/redis.js';

const memoryDedup = new Map<string, number>();

export function alertDedupKey(
  alertType: string,
  tokenAddress: string,
  walletAddress?: string,
): string {
  return `${alertType}:${tokenAddress.toLowerCase()}:${(walletAddress ?? 'global').toLowerCase()}`;
}

export async function shouldEmitAlert(key: string, ttlSec = 300): Promise<boolean> {
  const r = getRedis();
  if (r) {
    try {
      const res = await r.set(`alert:dedup:${key}`, '1', 'EX', ttlSec, 'NX');
      return res === 'OK';
    } catch {
      /* fallback memory */
    }
  }
  const now = Date.now();
  const exp = memoryDedup.get(key);
  if (exp && exp > now) return false;
  memoryDedup.set(key, now + ttlSec * 1000);
  return true;
}
