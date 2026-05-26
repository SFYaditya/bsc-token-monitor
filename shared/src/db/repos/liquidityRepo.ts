import { dbGet, dbRun } from '../pg/query.js';

export async function upsertLiquidityStat(input: {
  token_address: string;
  pair_address?: string;
  liquidity_usd: number;
  lp_burned_pct: number;
  lp_locked_pct: number;
  lp_holder_count?: number;
  change_24h_pct: number;
  change_7d_pct: number;
}): Promise<void> {
  await dbRun(
    `INSERT INTO token_liquidity_stat (
      token_address, pair_address, liquidity_usd, lp_burned_pct, lp_locked_pct,
      lp_holder_count, change_24h_pct, change_7d_pct, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (token_address) DO UPDATE SET
      pair_address = EXCLUDED.pair_address,
      liquidity_usd = EXCLUDED.liquidity_usd,
      lp_burned_pct = EXCLUDED.lp_burned_pct,
      lp_locked_pct = EXCLUDED.lp_locked_pct,
      lp_holder_count = EXCLUDED.lp_holder_count,
      change_24h_pct = EXCLUDED.change_24h_pct,
      change_7d_pct = EXCLUDED.change_7d_pct,
      updated_at = EXCLUDED.updated_at`,
    [
      input.token_address.toLowerCase(),
      input.pair_address?.toLowerCase() ?? null,
      input.liquidity_usd,
      input.lp_burned_pct,
      input.lp_locked_pct,
      input.lp_holder_count ?? 0,
      input.change_24h_pct,
      input.change_7d_pct,
      Date.now(),
    ],
  );
}

export async function getLiquidityStat(
  tokenAddress: string,
): Promise<Record<string, unknown> | null> {
  const row = await dbGet<Record<string, unknown>>(
    'SELECT * FROM token_liquidity_stat WHERE token_address = ?',
    [tokenAddress.toLowerCase()],
  );
  return row ?? null;
}
