import { dbRun } from '../db/pg/query.js';
import { CHAIN_ID } from '../config.js';

export type BalanceSource = 'EVENT_ESTIMATED' | 'ONCHAIN_CONFIRMED';

export async function setHolderBalanceSource(
  tokenAddress: string,
  walletAddress: string,
  source: BalanceSource,
  checkedAt = Date.now(),
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();
  await dbRun(
    `UPDATE holder_profiles SET balance_source = ?, last_balance_checked_at = ?, updated_at = ?
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [source, checkedAt, checkedAt, CHAIN_ID, token, wallet],
  );
}
