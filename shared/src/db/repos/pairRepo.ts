import { dbAll, dbGet, dbRunAffected } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';

export async function insertPair(input: {
  token_address: string;
  pair_address: string;
  token0: string;
  token1: string;
  quote_token: string;
  quote_symbol?: string;
  created_tx_hash?: string;
  created_block?: number;
}): Promise<boolean> {
  try {
    const n = await dbRunAffected(
      `INSERT INTO token_pair (
        chain_id, token_address, pair_address, token0, token1, quote_token, quote_symbol,
        created_tx_hash, created_block, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chain_id, pair_address) DO NOTHING`,
      [
        CHAIN_ID,
        input.token_address.toLowerCase(),
        input.pair_address.toLowerCase(),
        input.token0.toLowerCase(),
        input.token1.toLowerCase(),
        input.quote_token.toLowerCase(),
        input.quote_symbol ?? null,
        input.created_tx_hash ?? null,
        input.created_block ?? null,
        Date.now(),
      ],
    );
    return n > 0;
  } catch {
    return false;
  }
}

export async function getPairByToken(tokenAddress: string) {
  return dbGet<Record<string, unknown>>(
    'SELECT * FROM token_pair WHERE chain_id = ? AND token_address = ?',
    [CHAIN_ID, tokenAddress.toLowerCase()],
  );
}

export async function getPairsByTokens(tokenAddresses: string[]) {
  const addrs = [...new Set(tokenAddresses.map((a) => a.toLowerCase()).filter(Boolean))];
  if (addrs.length === 0) return new Map<string, Record<string, unknown>>();
  const placeholders = addrs.map(() => '?').join(',');
  const rows = (await dbAll(
    `SELECT * FROM token_pair WHERE chain_id = ? AND token_address IN (${placeholders})`,
    [CHAIN_ID, ...addrs],
  )) as Record<string, unknown>[];
  const map = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const t = String(row.token_address ?? '').toLowerCase();
    if (t) map.set(t, row);
  }
  return map;
}

export async function getPairByAddress(pairAddress: string) {
  return dbGet<Record<string, unknown>>(
    'SELECT * FROM token_pair WHERE chain_id = ? AND pair_address = ?',
    [CHAIN_ID, pairAddress.toLowerCase()],
  );
}

export async function countPairs(): Promise<number> {
  const row = await dbGet<{ c: number }>('SELECT COUNT(*)::int AS c FROM token_pair');
  return row?.c ?? 0;
}
