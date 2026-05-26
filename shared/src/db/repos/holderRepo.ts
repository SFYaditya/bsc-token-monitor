import { dbAll, dbGet, dbRun } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import { compareBalanceDesc } from '../../token/balanceMath.js';

export async function upsertHolder(input: {
  token_address: string;
  holder_address: string;
  balance: string;
  balance_percent?: number;
  address_tag?: string;
  last_active_time?: number;
}): Promise<void> {
  const now = input.last_active_time ?? Date.now();
  await dbRun(
    `INSERT INTO token_holder (
      chain_id, token_address, holder_address, balance, balance_percent, last_active_time, address_tag
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (chain_id, token_address, holder_address) DO UPDATE SET
      balance = EXCLUDED.balance,
      balance_percent = EXCLUDED.balance_percent,
      last_active_time = EXCLUDED.last_active_time,
      address_tag = COALESCE(EXCLUDED.address_tag, token_holder.address_tag)`,
    [
      CHAIN_ID,
      input.token_address.toLowerCase(),
      input.holder_address.toLowerCase(),
      input.balance,
      input.balance_percent ?? 0,
      now,
      input.address_tag ?? null,
    ],
  );
}

export async function getHolderBalance(
  tokenAddress: string,
  holderAddress: string,
): Promise<string | null> {
  const row = await dbGet<{ balance: string }>(
    'SELECT balance FROM token_holder WHERE chain_id = ? AND token_address = ? AND holder_address = ?',
    [CHAIN_ID, tokenAddress.toLowerCase(), holderAddress.toLowerCase()],
  );
  return row?.balance ?? null;
}

export async function deleteHolder(tokenAddress: string, holderAddress: string): Promise<void> {
  await dbRun(
    'DELETE FROM token_holder WHERE chain_id = ? AND token_address = ? AND holder_address = ?',
    [CHAIN_ID, tokenAddress.toLowerCase(), holderAddress.toLowerCase()],
  );
}

export async function listHolders(
  tokenAddress: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = Math.min(500, opts.pageSize ?? 50);
  const offset = (page - 1) * pageSize;
  const token = tokenAddress.toLowerCase();
  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM token_holder WHERE chain_id = ? AND token_address = ? AND balance != '0' AND balance != ''`,
    [CHAIN_ID, token],
  );
  const total = totalRow?.c ?? 0;

  const rows = await dbAll<Record<string, unknown>>(
    `SELECT h.*, s.buy_count, s.sell_count, s.total_buy_value, s.total_sell_value, s.is_cleared, s.last_trade_time
     FROM token_holder h
     LEFT JOIN token_address_stat s ON s.chain_id = h.chain_id AND s.token_address = h.token_address AND s.wallet_address = h.holder_address
     WHERE h.chain_id = ? AND h.token_address = ? AND h.balance != '0' AND h.balance != ''`,
    [CHAIN_ID, token],
  );

  rows.sort((a, b) => compareBalanceDesc(String(a.balance ?? '0'), String(b.balance ?? '0')));

  const slice = rows.slice(offset, offset + pageSize);
  const ranked = slice.map((row, i) => ({
    ...row,
    rank: offset + i + 1,
  }));
  return { items: ranked, total };
}
