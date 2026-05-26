import type { Provider } from 'ethers';
import {
  fetchWbnbUsd,
  priceFromReserves,
  type PairReserves,
} from '../market/price.js';
import {
  insertPriceSnapshot,
  upsertMarketCache,
  getTokenStats24h,
} from '../db/repos/marketRepo.js';
import { countHolders } from '../db/repos/statRepo.js';
import { getContract } from '../db/repos/contractRepo.js';
import { publishRealtimeThrottled } from '../realtime/throttle.js';
import type { IngestPairCtx } from '../chain/ingest.js';
import { quoteSymbol } from '../swap/parse.js';

/** 由 Pair Sync 事件储备量推导价格（避免每块 getReserves） */
export async function updateMarketFromSyncReserves(
  provider: Provider,
  input: {
  tokenAddress: string;
  pairCtx: IngestPairCtx;
  reserve0: string;
  reserve1: string;
}): Promise<void> {
  const token = input.tokenAddress.toLowerCase();
  const r0 = BigInt(input.reserve0);
  const r1 = BigInt(input.reserve1);
  const reserves: PairReserves = {
    tokenReserve: input.pairCtx.tokenIsToken0 ? r0 : r1,
    quoteReserve: input.pairCtx.tokenIsToken0 ? r1 : r0,
    tokenDecimals: input.pairCtx.tokenDecimals,
    quoteDecimals: input.pairCtx.quoteDecimals,
    quoteToken: input.pairCtx.quoteToken,
    quoteSymbol:
      input.pairCtx.quoteSymbol ?? quoteSymbol(input.pairCtx.quoteToken),
    tokenIsToken0: input.pairCtx.tokenIsToken0,
  };
  const wbnbUsd = await fetchWbnbUsd(provider);
  const snap = priceFromReserves(reserves, wbnbUsd);
  const now = Date.now();

  await insertPriceSnapshot(token, snap, now);
  const contract = await getContract(token);
  const symbol = contract?.token_symbol ?? token.slice(0, 8);
  const stats24h = await getTokenStats24h(token);
  const volume24h = stats24h.buyVolume24hUsd + stats24h.sellVolume24hUsd;
  const holders = await countHolders(token);
  await upsertMarketCache(token, symbol, snap, holders, volume24h, now);

  void publishRealtimeThrottled({
    type: 'price_update',
    tokenAddress: token,
    data: {
      price: String(snap.priceUsd),
      liquidityUsd: snap.liquidityUsd ?? 0,
      updatedAt: now,
      source: 'sync_event',
    },
  });
}
