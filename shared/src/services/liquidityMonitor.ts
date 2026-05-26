import type { Provider } from 'ethers';
import { LIQUIDITY_DROP_PCT } from '../config.js';
import { dbGet, dbRun } from '../db/pg/query.js';
import { upsertLiquidityStat } from '../db/repos/liquidityRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { getPairByToken } from '../db/repos/pairRepo.js';
import { scanLpLock } from './lpLock.js';
import { dispatchAlert } from './alertDispatcher.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getMeta, setMeta } from '../db/index.js';

async function liquidityAt(token: string, beforeMs: number): Promise<number | null> {
  const row = await dbGet<{ liquidity_usd: number }>(
    `SELECT liquidity_usd FROM token_price_snapshot
     WHERE token_address = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1`,
    [token, beforeMs],
  );
  return row?.liquidity_usd ?? null;
}

export async function refreshLiquidityMonitor(
  provider: Provider,
  tokenAddress: string,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const market = await getTokenMarket(token);
  if (!market) return;

  const now = Date.now();
  const liq24 = await liquidityAt(token, now - 24 * 60 * 60_000);
  const liq7d = await liquidityAt(token, now - 7 * 24 * 60 * 60_000);
  const current = market.liquidityUsd;

  const change24h =
    liq24 && liq24 > 0 ? ((current - liq24) / liq24) * 100 : 0;
  const change7d =
    liq7d && liq7d > 0 ? ((current - liq7d) / liq7d) * 100 : 0;

  const lp = await scanLpLock(provider, token);
  const pair = await getPairByToken(token);

  await upsertLiquidityStat({
    token_address: token,
    pair_address: pair?.pair_address as string | undefined,
    liquidity_usd: current,
    lp_burned_pct: lp.burnedPct,
    lp_locked_pct: lp.lockedPct,
    change_24h_pct: change24h,
    change_7d_pct: change7d,
  });

  await dbRun(
    `UPDATE token_market_cache SET liquidity_change_24h = ?, liquidity_change_7d = ? WHERE token_address = ?`,
    [change24h, change7d, token],
  );

  if (liq24 && liq24 > 0) {
    const dropPct = ((liq24 - current) / liq24) * 100;
    const lastKey = `liq_drop_alert_${token}`;
    const lastAt = Number((await getMeta(lastKey)) ?? 0);
    if (dropPct >= LIQUIDITY_DROP_PCT && now - lastAt > 4 * 60 * 60_000) {
      await setMeta(lastKey, String(now));
      const contract = await getContract(token);
      const symbol = contract?.token_symbol ?? token.slice(0, 8);
      void dispatchAlert({
        alert_type: 'liquidity_drop',
        token_address: token,
        level: dropPct >= LIQUIDITY_DROP_PCT * 2 ? 'HIGH' : 'MEDIUM',
        message: `⚠️ 流动性下降 ${dropPct.toFixed(1)}%\n${symbol} · 当前 $${current.toFixed(0)} · 24h前 $${liq24.toFixed(0)}`,
      });
    }
  }
}

export async function alertLargeRemoveLiquidity(input: {
  tokenAddress: string;
  pairAddress: string;
  trader: string;
  amountUsd: number;
  txHash: string;
}): Promise<void> {
  if (input.amountUsd < 500) return;
  const contract = await getContract(input.tokenAddress);
  const symbol = contract?.token_symbol ?? 'Token';
  void dispatchAlert({
    alert_type: 'large_remove_liquidity',
    token_address: input.tokenAddress,
    pair_address: input.pairAddress,
    wallet_address: input.trader,
    tx_hash: input.txHash,
    amount_usd: input.amountUsd,
    level: input.amountUsd >= 5000 ? 'HIGH' : 'MEDIUM',
    message: `🔻 大额撤池 · ${symbol}\n$${input.amountUsd.toFixed(0)} · ${input.trader.slice(0, 8)}...`,
  });
}
