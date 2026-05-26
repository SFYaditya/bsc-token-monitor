import { dbAll, dbGet, dbRunAffected } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import type { EventType } from '../../lifecycle.js';
import { eventExists as chainEventExists } from '../eventDedup.js';

export { eventExists, shouldSkipChainEvent, getRawEventStatus } from '../eventDedup.js';

export async function insertEvent(input: {
  token_address: string;
  event_type: EventType;
  tx_hash: string;
  log_index?: number;
  block_number: number;
  event_time: number;
  from_address?: string;
  to_address?: string;
  trader?: string;
  token_amount?: string;
  quote_amount?: string;
  price?: number;
  pair_address?: string;
  amount_usd?: number;
  balance_after?: string;
  quote_balance_after?: string;
}): Promise<boolean> {
  try {
    const n = await dbRunAffected(
      `INSERT INTO token_event (
        chain_id, token_address, event_type, tx_hash, log_index, block_number, event_time,
        from_address, to_address, trader, token_amount, quote_amount, price, pair_address, amount_usd, balance_after, quote_balance_after
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chain_id, tx_hash, log_index, token_address) DO NOTHING`,
      [
        CHAIN_ID,
        input.token_address.toLowerCase(),
        input.event_type,
        input.tx_hash,
        input.log_index ?? 0,
        input.block_number,
        input.event_time,
        input.from_address?.toLowerCase() ?? null,
        input.to_address?.toLowerCase() ?? null,
        input.trader?.toLowerCase() ?? null,
        input.token_amount ?? '0',
        input.quote_amount ?? '0',
        input.price ?? 0,
        input.pair_address?.toLowerCase() ?? null,
        input.amount_usd ?? 0,
        input.balance_after ?? null,
        input.quote_balance_after ?? null,
      ],
    );
    if (n > 0) return true;
    return chainEventExists(
      input.token_address,
      input.tx_hash,
      input.log_index ?? 0,
    );
  } catch {
    return false;
  }
}

export async function listEvents(
  tokenAddress: string,
  opts: {
    event_type?: string;
    event_types?: string[];
    trader?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = Math.min(200, opts.pageSize ?? 50);
  const offset = (page - 1) * pageSize;
  const conditions = ['chain_id = ?', 'token_address = ?'];
  const params: unknown[] = [CHAIN_ID, tokenAddress.toLowerCase()];
  if (opts.event_types?.length) {
    conditions.push(`event_type IN (${opts.event_types.map(() => '?').join(',')})`);
    params.push(...opts.event_types);
  } else if (opts.event_type) {
    conditions.push('event_type = ?');
    params.push(opts.event_type);
  }
  if (opts.trader) {
    conditions.push('(trader = ? OR from_address = ? OR to_address = ?)');
    const a = opts.trader.toLowerCase();
    params.push(a, a, a);
  }
  const where = conditions.join(' AND ');
  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM token_event WHERE ${where}`,
    params,
  );
  const total = totalRow?.c ?? 0;
  const items = await dbAll<Record<string, unknown>>(
    `SELECT * FROM token_event WHERE ${where} ORDER BY event_time DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  return { items, total };
}

export async function getLastSwapTrade(
  tokenAddress: string,
): Promise<{
  price: number;
  amount_usd: number;
  token_amount: string;
  event_time: number;
  event_type: string;
} | null> {
  const row = await dbGet<{
    price: number;
    amount_usd: number;
    token_amount: string;
    event_time: number;
    event_type: string;
  }>(
    `SELECT price, amount_usd, token_amount, event_time, event_type
     FROM token_event
     WHERE chain_id = ? AND token_address = ? AND event_type IN ('buy', 'sell')
     ORDER BY event_time DESC LIMIT 1`,
    [CHAIN_ID, tokenAddress.toLowerCase()],
  );
  if (!row) return null;
  return {
    price: Number(row.price ?? 0),
    amount_usd: Number(row.amount_usd ?? 0),
    token_amount: String(row.token_amount ?? '0'),
    event_time: Number(row.event_time ?? 0),
    event_type: String(row.event_type),
  };
}

export async function hasSwapEvent(tokenAddress: string): Promise<boolean> {
  const row = await dbGet(
    `SELECT 1 AS ok FROM token_event WHERE chain_id = ? AND token_address = ? AND event_type IN ('buy','sell') LIMIT 1`,
    [CHAIN_ID, tokenAddress.toLowerCase()],
  );
  return !!row;
}

export async function countEventsByType(tokenAddress: string): Promise<Record<string, number>> {
  const rows = await dbAll<{ event_type: string; c: number }>(
    `SELECT event_type, COUNT(*)::int AS c FROM token_event WHERE chain_id = ? AND token_address = ? GROUP BY event_type`,
    [CHAIN_ID, tokenAddress.toLowerCase()],
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.event_type] = r.c;
  return out;
}
