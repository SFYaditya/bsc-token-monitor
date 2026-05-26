import type { Provider } from 'ethers';
import { loadMonitorTokens } from '../monitorTokens.js';
import { fetchTokenMarket } from '../market/price.js';
import {
  insertPriceSnapshot,
  upsertMarketCache,
  getTokenStats24h,
  pruneOldSnapshots,
} from '../db/repos/marketRepo.js';
import { countHolders } from '../db/repos/statRepo.js';
import { getContract } from '../db/repos/contractRepo.js';
import { runPhase2Maintenance } from './phase2Runner.js';
import { publishRealtime } from '../realtime/publish.js';

export async function refreshTokenMarket(provider: Provider, tokenAddress: string): Promise<void> {
  const snap = await fetchTokenMarket(provider, tokenAddress);
  if (!snap) return;

  const now = Date.now();
  insertPriceSnapshot(tokenAddress, snap, now);

  const contract = await getContract(tokenAddress);
  const symbol = contract?.token_symbol ?? tokenAddress.slice(0, 8);
  const stats24h = await getTokenStats24h(tokenAddress);
  const volume24h = stats24h.buyVolume24hUsd + stats24h.sellVolume24hUsd;
  const holders = await countHolders(tokenAddress);

  await upsertMarketCache(tokenAddress, symbol, snap, holders, volume24h, now);

  void publishRealtime({
    type: 'price_update',
    tokenAddress,
    data: {
      price: String(snap.priceUsd),
      priceChange5m: (snap as { priceChange5m?: number }).priceChange5m ?? 0,
      priceChange15m: (snap as { priceChange15m?: number }).priceChange15m ?? 0,
      priceChange1h: (snap as { priceChange1h?: number }).priceChange1h ?? 0,
      priceChange24h: (snap as { priceChange24h?: number }).priceChange24h ?? 0,
      volume24hUsd: volume24h,
      liquidityUsd: snap.liquidityUsd ?? 0,
      updatedAt: now,
    },
  });
}

export async function refreshAllMonitorMarkets(provider: Provider): Promise<void> {
  const tokens = loadMonitorTokens();
  for (const cfg of tokens) {
    try {
      await refreshTokenMarket(provider, cfg.tokenAddress);
    } catch (err) {
      console.error(
        `[Market] ${cfg.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  pruneOldSnapshots(8 * 24 * 60 * 60_000);
  await runPhase2Maintenance(provider);
}
