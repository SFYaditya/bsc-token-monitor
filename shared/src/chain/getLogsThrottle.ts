import {
  SYNC_GETLOGS_MAX_BACKOFF_MS,
  SYNC_GETLOGS_MIN_INTERVAL_MS,
} from './listenerConfig.js';
import { isRateLimitError } from '../rpc/mask.js';

let lastGetLogsAt = 0;
let backoffMs = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 全局限流：避免多 Token / 多路径并发打满 eth_getLogs */
export async function acquireGetLogsSlot(): Promise<void> {
  const now = Date.now();
  const nextAt = lastGetLogsAt + SYNC_GETLOGS_MIN_INTERVAL_MS + backoffMs;
  const wait = nextAt - now;
  if (wait > 0) await sleep(wait);
}

export function noteGetLogsSuccess(): void {
  lastGetLogsAt = Date.now();
  if (backoffMs > 0) {
    backoffMs = Math.max(0, Math.floor(backoffMs * 0.5));
  }
}

export function noteGetLogsRateLimited(err: unknown): void {
  lastGetLogsAt = Date.now();
  if (!isRateLimitError(err)) return;
  backoffMs = backoffMs
    ? Math.min(SYNC_GETLOGS_MAX_BACKOFF_MS, backoffMs * 2)
    : SYNC_GETLOGS_MIN_INTERVAL_MS * 2;
}

export function getGetLogsBackoffMs(): number {
  return backoffMs;
}
