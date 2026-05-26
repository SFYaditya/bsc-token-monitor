import { dbAll, dbGet, dbRun, dbRunAffected } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';

export async function recordStaking(input: {
  token_address: string;
  wallet_address: string;
  action: 'stake' | 'unstake' | 'claim';
  amount: string;
  tx_hash: string;
  block_number?: number;
  event_time: number;
}): Promise<boolean> {
  try {
    const n = await dbRunAffected(
      `INSERT INTO staking_record (
        chain_id, token_address, wallet_address, action, amount, tx_hash, block_number, event_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chain_id, tx_hash, token_address, wallet_address, action) DO NOTHING`,
      [
        CHAIN_ID,
        input.token_address.toLowerCase(),
        input.wallet_address.toLowerCase(),
        input.action,
        input.amount,
        input.tx_hash,
        input.block_number ?? null,
        input.event_time,
      ],
    );
    if (n > 0) await refreshStakingStat(input.token_address);
    return n > 0;
  } catch {
    return false;
  }
}

async function refreshStakingStat(tokenAddress: string): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const since = Date.now() - 24 * 60 * 60_000;

  const total = await dbGet<{ v: number }>(
    `SELECT COALESCE(SUM(CASE WHEN action='stake' THEN CAST(amount AS BIGINT) ELSE -CAST(amount AS BIGINT) END), 0)::bigint AS v
     FROM staking_record WHERE chain_id = ? AND token_address = ?`,
    [CHAIN_ID, token],
  );

  const stakers = await dbGet<{ c: number }>(
    `SELECT COUNT(DISTINCT wallet_address)::int AS c FROM staking_record WHERE chain_id = ? AND token_address = ?`,
    [CHAIN_ID, token],
  );

  const s24 = await dbGet<{ v: number }>(
    `SELECT COALESCE(SUM(CAST(amount AS BIGINT)), 0)::bigint AS v FROM staking_record
     WHERE chain_id = ? AND token_address = ? AND action = 'stake' AND event_time >= ?`,
    [CHAIN_ID, token, since],
  );

  const u24 = await dbGet<{ v: number }>(
    `SELECT COALESCE(SUM(CAST(amount AS BIGINT)), 0)::bigint AS v FROM staking_record
     WHERE chain_id = ? AND token_address = ? AND action = 'unstake' AND event_time >= ?`,
    [CHAIN_ID, token, since],
  );

  const now = Date.now();
  await dbRun(
    `INSERT INTO token_staking_stat (chain_id, token_address, total_staked, staker_count, stake_24h, unstake_24h, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chain_id, token_address) DO UPDATE SET
       total_staked = EXCLUDED.total_staked,
       staker_count = EXCLUDED.staker_count,
       stake_24h = EXCLUDED.stake_24h,
       unstake_24h = EXCLUDED.unstake_24h,
       updated_at = EXCLUDED.updated_at`,
    [
      CHAIN_ID,
      token,
      String(Math.max(0, Number(total?.v ?? 0))),
      stakers?.c ?? 0,
      String(s24?.v ?? 0),
      String(u24?.v ?? 0),
      now,
    ],
  );
}

export async function getStakingStat(tokenAddress: string): Promise<Record<string, unknown> | null> {
  const row = await dbGet<Record<string, unknown>>(
    'SELECT * FROM token_staking_stat WHERE chain_id = ? AND token_address = ?',
    [CHAIN_ID, tokenAddress.toLowerCase()],
  );
  return row ?? null;
}

export async function listStakingRecords(
  tokenAddress: string,
  opts: { wallet?: string; page?: number; pageSize?: number } = {},
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const token = tokenAddress.toLowerCase();
  const page = opts.page ?? 1;
  const pageSize = Math.min(100, opts.pageSize ?? 50);
  const offset = (page - 1) * pageSize;
  const conditions = ['chain_id = ?', 'token_address = ?'];
  const params: unknown[] = [CHAIN_ID, token];
  if (opts.wallet) {
    conditions.push('wallet_address = ?');
    params.push(opts.wallet.toLowerCase());
  }
  const where = conditions.join(' AND ');
  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM staking_record WHERE ${where}`,
    params,
  );
  const total = totalRow?.c ?? 0;
  const items = await dbAll<Record<string, unknown>>(
    `SELECT * FROM staking_record WHERE ${where} ORDER BY event_time DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  return { items, total };
}

export async function updateStakingBalance(
  tokenAddress: string,
  wallet: string,
  balance: string,
): Promise<void> {
  await dbRun(
    `UPDATE token_address_stat SET staking_balance = ?
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [balance, CHAIN_ID, tokenAddress.toLowerCase(), wallet.toLowerCase()],
  );
}
