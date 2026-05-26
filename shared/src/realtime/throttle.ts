import { WS_HOLDER_UPDATE_MIN_MS, WS_PRICE_UPDATE_MIN_MS } from '../chain/listenerConfig.js';
import { publishRealtime, type RealtimeMessage } from './publish.js';

const lastSentAt = new Map<string, number>();

function throttleKey(msg: RealtimeMessage): string {
  const token = (msg.tokenAddress ?? 'global').toLowerCase();
  const wallet = String((msg.data as { walletAddress?: string }).walletAddress ?? '').toLowerCase();
  if (msg.type === 'holder_update' && wallet) {
    return `${msg.type}:${token}:${wallet}`;
  }
  return `${msg.type}:${token}`;
}

function minIntervalFor(type: string): number {
  if (type === 'price_update') return WS_PRICE_UPDATE_MIN_MS;
  if (type === 'holder_update') return WS_HOLDER_UPDATE_MIN_MS;
  return 0;
}

/** 对高频类型节流；new_trade / alert_event 等仍即时推送 */
export async function publishRealtimeThrottled(msg: RealtimeMessage): Promise<void> {
  const minMs = minIntervalFor(msg.type);
  if (minMs <= 0) {
    await publishRealtime(msg);
    return;
  }
  const key = throttleKey(msg);
  const now = Date.now();
  const last = lastSentAt.get(key) ?? 0;
  if (now - last < minMs) return;
  lastSentAt.set(key, now);
  await publishRealtime(msg);
}
