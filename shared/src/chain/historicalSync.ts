/**
 * @deprecated 统一 CHAIN_EVENTS 扫描已替换为分层 listener。
 * 保留导出以兼容旧调用方。
 */
import type { Provider } from 'ethers';
import {
  bootstrapLayeredListeners,
  runAllLayeredListeners,
  retryLayeredFailedChunks,
} from './layeredListeners.js';

export const SYNC_TYPE = 'fast_pair_listener' as const;

export type TokenSyncContext = {
  token: string;
  symbol: string;
};

export type LayeredCatchUpResult = Awaited<ReturnType<typeof runAllLayeredListeners>>;

export async function catchUpAllMonitorTokens(provider: Provider): Promise<LayeredCatchUpResult> {
  return runAllLayeredListeners(provider, { label: 'CatchUp' });
}

export async function runHistoricalSyncLoop(provider: Provider): Promise<void> {
  await bootstrapLayeredListeners(provider);
}

export async function runLayeredCatchUp(
  provider: Provider,
  opts?: { maxScansPerTask?: number; label?: string },
): Promise<LayeredCatchUpResult> {
  return runAllLayeredListeners(provider, opts);
}

export function resolveSyncLayer(): 'idle' | 'tail' | 'backfill' {
  return 'idle';
}

export async function syncTokenHistory(
  provider: Provider,
  _tokenAddress: string,
): Promise<{ fromBlock: number; toBlock: number; chunks: number; caughtUp: boolean }> {
  await runAllLayeredListeners(provider, { maxScansPerTask: 20, label: 'History' });
  return { fromBlock: 0, toBlock: 0, chunks: 0, caughtUp: true };
}

export async function retryFailedSyncChunks(provider: Provider): Promise<number> {
  return retryLayeredFailedChunks(provider);
}
