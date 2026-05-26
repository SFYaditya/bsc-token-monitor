import { dbAll, dbGet, dbRun } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import type { MarketSnapshot } from '../../market/price.js';
import type { TokenMarket, TokenStats24h } from '../../types.js';
import { countHolders } from './statRepo.js';
import { getContract } from './contractRepo.js';
import { getLastSwapTrade } from './eventRepo.js';
import { tradePriceUsdFromEvent } from '../../market/tradePrice.js';

export async function insertPriceSnapshot(
  tokenAddress: string,
  snap: MarketSnapshot,
  recordedAt: number,
): Promise<void> {
  await dbRun(
    `INSERT INTO token_price_snapshot (
      chain_id, token_address, price_usd, liquidity_usd, token_reserve, quote_reserve, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      CHAIN_ID,
      tokenAddress.toLowerCase(),
      snap.priceUsd,
      snap.liquidityUsd,
      snap.tokenReserve,
      snap.quoteReserve,
      recordedAt,
    ],
  );
}

async function priceAtOrBefore(tokenAddress: string, beforeMs: number): Promise<number | null> {
  const row = await dbGet<{ price_usd: number }>(
    `SELECT price_usd FROM token_price_snapshot
     WHERE chain_id = ? AND token_address = ? AND recorded_at <= ?
     ORDER BY recorded_at DESC LIMIT 1`,
    [CHAIN_ID, tokenAddress.toLowerCase(), beforeMs],
  );
  return row?.price_usd ?? null;
}

function pctChange(current: number, past: number | null): number {
  if (!past || past <= 0) return 0;
  return ((current - past) / past) * 100;
}

export async function upsertMarketCache(
  tokenAddress: string,
  symbol: string,
  snap: MarketSnapshot,
  holderCount: number,
  volume24hUsd: number,
  now: number,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const p5 = await priceAtOrBefore(token, now - 5 * 60_000);
  const p15 = await priceAtOrBefore(token, now - 15 * 60_000);
  const p1h = await priceAtOrBefore(token, now - 60 * 60_000);
  const p24 = await priceAtOrBefore(token, now - 24 * 60 * 60_000);

  const dayStart = now - 24 * 60 * 60_000;
  const hiLo = await dbGet<{ hi: number | null; lo: number | null }>(
    `SELECT MAX(price_usd) AS hi, MIN(price_usd) AS lo FROM token_price_snapshot
     WHERE chain_id = ? AND token_address = ? AND recorded_at >= ?`,
    [CHAIN_ID, token, dayStart],
  );

  await dbRun(
    `INSERT INTO token_market_cache (
      chain_id, token_address, symbol, price_usd, price_change_5m, price_change_15m, price_change_1h,
      price_change_24h, high_24h, low_24h, volume_24h_usd, liquidity_usd,
      token_reserve, quote_reserve, holder_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (chain_id, token_address) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      price_usd = EXCLUDED.price_usd,
      price_change_5m = EXCLUDED.price_change_5m,
      price_change_15m = EXCLUDED.price_change_15m,
      price_change_1h = EXCLUDED.price_change_1h,
      price_change_24h = EXCLUDED.price_change_24h,
      high_24h = EXCLUDED.high_24h,
      low_24h = EXCLUDED.low_24h,
      volume_24h_usd = EXCLUDED.volume_24h_usd,
      liquidity_usd = EXCLUDED.liquidity_usd,
      token_reserve = EXCLUDED.token_reserve,
      quote_reserve = EXCLUDED.quote_reserve,
      holder_count = EXCLUDED.holder_count,
      updated_at = EXCLUDED.updated_at`,
    [
      CHAIN_ID,
      token,
      symbol,
      snap.priceUsd,
      pctChange(snap.priceUsd, p5),
      pctChange(snap.priceUsd, p15),
      pctChange(snap.priceUsd, p1h),
      pctChange(snap.priceUsd, p24),
      hiLo?.hi ?? snap.priceUsd,
      hiLo?.lo ?? snap.priceUsd,
      volume24hUsd,
      snap.liquidityUsd,
      snap.tokenReserve,
      snap.quoteReserve,
      holderCount,
      now,
    ],
  );
}

export async function syncMarketHolderCount(tokenAddress: string): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const count = await countHolders(token);
  const now = Date.now();
  await dbRun(
    `UPDATE token_market_cache SET holder_count = ?, updated_at = ? WHERE chain_id = ? AND token_address = ?`,
    [count, now, CHAIN_ID, token],
  );
  return count;
}

/** 无 Pair / 无行情时仍写入占位，避免前端 overview 为空 */
export async function ensureMarketCachePlaceholder(
  tokenAddress: string,
  symbol: string,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const existing = await dbGet(
    'SELECT 1 AS ok FROM token_market_cache WHERE chain_id = ? AND token_address = ?',
    [CHAIN_ID, token],
  );
  if (existing) return;
  const now = Date.now();
  await dbRun(
    `INSERT INTO token_market_cache (
      chain_id, token_address, symbol, price_usd, volume_24h_usd, liquidity_usd, holder_count, updated_at
    ) VALUES (?, ?, ?, 0, 0, 0, 0, ?)`,
    [CHAIN_ID, token, symbol, now],
  );
}

export async function getTokenOverview(
  tokenAddress: string,
): Promise<Record<string, unknown> | null> {
  const token = tokenAddress.toLowerCase();
  const market = await getTokenMarket(token);
  const stats24h = await getTokenStats24h(token);
  const holderCount = await countHolders(token);
  const contract = await getContract(token);
  const dec = contract?.token_decimals ?? 18;
  const lastSwap = await getLastSwapTrade(token);
  const lastTradePriceUsd = lastSwap
    ? tradePriceUsdFromEvent(lastSwap.amount_usd, lastSwap.token_amount, dec, lastSwap.price)
    : 0;
  const lastTradeTime = lastSwap?.event_time ?? 0;
  if (!market) {
    return {
      tokenAddress: token,
      symbol: contract?.token_symbol ?? token.slice(0, 8),
      priceUsd: 0,
      priceChange24h: 0,
      volume24hUsd: 0,
      liquidityUsd: 0,
      holderCount,
      buyCount24h: stats24h.buyCount24h,
      sellCount24h: stats24h.sellCount24h,
      buyVolume24hUsd: stats24h.buyVolume24hUsd,
      sellVolume24hUsd: stats24h.sellVolume24hUsd,
      netBuyVolume24hUsd: stats24h.netBuyVolume24hUsd,
      lastTradePriceUsd,
      lastTradeTime,
      updatedAt: Date.now(),
      hasMarket: false,
    };
  }
  return {
    tokenAddress: market.tokenAddress,
    symbol: market.symbol,
    priceUsd: market.priceUsd,
    priceChange24h: market.priceChange24h,
    volume24hUsd: market.volume24hUsd,
    liquidityUsd: market.liquidityUsd,
    holderCount,
    buyCount24h: stats24h.buyCount24h,
    sellCount24h: stats24h.sellCount24h,
    buyVolume24hUsd: stats24h.buyVolume24hUsd,
    sellVolume24hUsd: stats24h.sellVolume24hUsd,
    netBuyVolume24hUsd: stats24h.netBuyVolume24hUsd,
    lastTradePriceUsd,
    lastTradeTime,
    updatedAt: market.updatedAt,
    hasMarket: true,
  };
}

export async function getTokenMarket(tokenAddress: string): Promise<TokenMarket | null> {
  const row = await dbGet<Record<string, unknown>>(
    'SELECT * FROM token_market_cache WHERE chain_id = ? AND token_address = ?',
    [CHAIN_ID, tokenAddress.toLowerCase()],
  );
  if (!row) return null;
  return {
    tokenAddress: String(row.token_address),
    symbol: String(row.symbol ?? ''),
    priceUsd: Number(row.price_usd ?? 0),
    priceChange5m: Number(row.price_change_5m ?? 0),
    priceChange15m: Number(row.price_change_15m ?? 0),
    priceChange1h: Number(row.price_change_1h ?? 0),
    priceChange24h: Number(row.price_change_24h ?? 0),
    high24h: Number(row.high_24h ?? 0),
    low24h: Number(row.low_24h ?? 0),
    volume24hUsd: Number(row.volume_24h_usd ?? 0),
    liquidityUsd: Number(row.liquidity_usd ?? 0),
    tokenReserve: String(row.token_reserve ?? '0'),
    quoteReserve: String(row.quote_reserve ?? '0'),
    holderCount: Number(row.holder_count ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

export async function getTokenStats24h(tokenAddress: string): Promise<TokenStats24h> {
  const token = tokenAddress.toLowerCase();
  const since = Date.now() - 24 * 60 * 60_000;

  const buy = await dbGet<{ c: number; v: number }>(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(amount_usd), 0)::float AS v FROM token_event
     WHERE chain_id = ? AND token_address = ? AND event_type = 'buy' AND event_time >= ?`,
    [CHAIN_ID, token, since],
  );

  const sell = await dbGet<{ c: number; v: number }>(
    `SELECT COUNT(*)::int AS c, COALESCE(SUM(amount_usd), 0)::float AS v FROM token_event
     WHERE chain_id = ? AND token_address = ? AND event_type = 'sell' AND event_time >= ?`,
    [CHAIN_ID, token, since],
  );

  const active = await dbGet<{ c: number }>(
    `SELECT COUNT(DISTINCT trader)::int AS c FROM token_event
     WHERE chain_id = ? AND token_address = ? AND event_type IN ('buy','sell') AND event_time >= ? AND trader IS NOT NULL`,
    [CHAIN_ID, token, since],
  );

  const buyVol = Number(buy?.v ?? 0);
  const sellVol = Number(sell?.v ?? 0);

  return {
    tokenAddress: token,
    buyCount24h: buy?.c ?? 0,
    sellCount24h: sell?.c ?? 0,
    buyVolume24hUsd: buyVol,
    sellVolume24hUsd: sellVol,
    netBuyVolume24hUsd: buyVol - sellVol,
    activeWallets24h: active?.c ?? 0,
  };
}

export async function listPriceSnapshots(
  tokenAddress: string,
  sinceMs: number,
  limit = 500,
): Promise<{ t: number; price: number; liquidity: number }[]> {
  return dbAll(
    `SELECT recorded_at AS t, price_usd AS price, liquidity_usd AS liquidity
     FROM token_price_snapshot
     WHERE token_address = ? AND recorded_at >= ?
     ORDER BY recorded_at ASC
     LIMIT ?`,
    [tokenAddress.toLowerCase(), sinceMs, limit],
  ) as Promise<{ t: number; price: number; liquidity: number }[]>;
}

export async function listHourlyVolume(
  tokenAddress: string,
  sinceMs: number,
): Promise<{ t: number; buyUsd: number; sellUsd: number }[]> {
  return dbAll(
    `SELECT (CAST(event_time AS BIGINT) / 3600000) * 3600000 AS t,
      COALESCE(SUM(CASE WHEN event_type = 'buy' THEN amount_usd ELSE 0 END), 0) AS buyUsd,
      COALESCE(SUM(CASE WHEN event_type = 'sell' THEN amount_usd ELSE 0 END), 0) AS sellUsd
     FROM token_event
     WHERE chain_id = ? AND token_address = ? AND event_time >= ? AND event_type IN ('buy', 'sell')
     GROUP BY t
     ORDER BY t ASC`,
    [CHAIN_ID, tokenAddress.toLowerCase(), sinceMs],
  ) as Promise<{ t: number; buyUsd: number; sellUsd: number }[]>;
}

export async function pruneOldSnapshots(olderThanMs: number): Promise<void> {
  await dbRun('DELETE FROM token_price_snapshot WHERE chain_id = ? AND recorded_at < ?', [
    CHAIN_ID,
    Date.now() - olderThanMs,
  ]);
}
