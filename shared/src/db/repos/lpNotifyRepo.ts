import { dbGet, dbRun } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';

export type LpNotifyKey =
  | 'pair_created'
  | 'first_add_liquidity'
  | 'first_mint'
  | 'first_reserves';

export async function hasLpNotifySent(
  tokenAddress: string,
  pairAddress: string,
  notifyKey: LpNotifyKey,
): Promise<boolean> {
  const row = await dbGet(
    `SELECT 1 AS ok FROM lp_notify_state
     WHERE chain_id = ? AND token_address = ? AND pair_address = ? AND notify_key = ?`,
    [CHAIN_ID, tokenAddress.toLowerCase(), pairAddress.toLowerCase(), notifyKey],
  );
  return !!row;
}

export async function markLpNotifySent(input: {
  token_address: string;
  pair_address: string;
  notify_key: LpNotifyKey;
  tx_hash?: string;
  block_number?: number;
}): Promise<void> {
  await dbRun(
    `INSERT INTO lp_notify_state (
      chain_id, token_address, pair_address, notify_key, tx_hash, block_number, notified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (chain_id, token_address, pair_address, notify_key) DO NOTHING`,
    [
      CHAIN_ID,
      input.token_address.toLowerCase(),
      input.pair_address.toLowerCase(),
      input.notify_key,
      input.tx_hash ?? null,
      input.block_number ?? null,
      Date.now(),
    ],
  );
}
