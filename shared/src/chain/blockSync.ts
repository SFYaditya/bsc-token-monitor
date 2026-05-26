import type { Provider } from 'ethers';

/**
 * WSS 新区块回调：仅感知链头，不触发 getLogs。
 * 链上事件由 tokenTracker 的 WSS 订阅 + 分层轮询补扫（runLayeredCatchUp）覆盖。
 */
export async function syncMonitorTokensOnBlock(
  _provider: Provider,
  _blockNumber: number,
): Promise<void> {
  /* no-op: 避免每块重复 eth_getLogs */
}
