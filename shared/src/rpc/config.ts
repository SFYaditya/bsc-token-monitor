import { collectHttpsRpcUrls } from '../config.js';

export const RPC_TIMEOUT_MS = Math.max(1000, Number(process.env.BSC_RPC_TIMEOUT_MS ?? 5000));
export const RPC_MAX_LATENCY_MS = Math.max(200, Number(process.env.BSC_RPC_MAX_LATENCY_MS ?? 2000));
export const RPC_HEALTH_CHECK_INTERVAL_MS = Math.max(
  3000,
  Number(process.env.BSC_RPC_HEALTH_CHECK_INTERVAL_MS ?? 10_000),
);
export const RPC_FAILOVER_ENABLED = process.env.BSC_RPC_FAILOVER_ENABLED !== 'false';
export const RPC_DEFAULT_INDEX = Math.max(0, Number(process.env.BSC_DEFAULT_RPC_INDEX ?? 0));
export const RPC_MAX_CONSECUTIVE_FAILURES = 3;
export const RPC_MAX_GETLOGS_FAILURES = 3;
/** 限流后冷却时间（毫秒），期间不参与 failover 选择 */
export const RPC_RATE_LIMIT_COOLDOWN_MS = Math.max(
  60_000,
  Number(process.env.BSC_RPC_RATE_LIMIT_COOLDOWN_MS ?? 900_000),
);
/** true 时多次限流后从池中永久移除；默认仅冷却切换，避免公共节点被扫光 */
export const RPC_REMOVE_RATE_LIMITED = process.env.BSC_RPC_REMOVE_RATE_LIMITED === 'true';
export const RPC_RATE_LIMIT_REMOVE_AFTER_STRIKES = Math.max(
  2,
  Number(process.env.BSC_RPC_RATE_LIMIT_REMOVE_AFTER_STRIKES ?? 5),
);

export function listConfiguredRpcUrls(): string[] {
  const merged = collectHttpsRpcUrls();
  if (!merged.length) {
    throw new Error('No BSC RPC configured. Set BSC_RPC_URLS or BSC_RPC_URL in .env');
  }
  return merged;
}
