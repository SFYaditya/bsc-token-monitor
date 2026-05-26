import { dbAll, dbGet, dbRunAffected } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import type { AddressType } from './addressRepo.js';

export interface TokenTransactionInput {
  token_address: string;
  wallet_address: string;
  address_type: AddressType;
  is_contract: number;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: number;
  trade_type: string;
  side?: string | null;
  token_amount?: string;
  quote_amount?: string;
  amount_usd?: number;
  price?: number;
  balance_after?: string;
  quote_balance_after?: string;
  staking_balance_after?: string;
  buy_count_after?: number;
  sell_count_after?: number;
  from_address?: string;
  to_address?: string;
  pair_address?: string;
  contract_address?: string;
}

export async function insertTokenTransaction(input: TokenTransactionInput): Promise<boolean> {
  try {
    const n = await dbRunAffected(
      `INSERT INTO token_transactions (
        chain_id, token_address, wallet_address, address_type, is_contract,
        tx_hash, log_index, block_number, block_time,
        trade_type, side, token_amount, quote_amount, amount_usd, price,
        balance_after, quote_balance_after, staking_balance_after, buy_count_after, sell_count_after,
        from_address, to_address, pair_address, contract_address
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
      ON CONFLICT (chain_id, tx_hash, log_index, trade_type) DO NOTHING`,
      [
        CHAIN_ID,
        input.token_address.toLowerCase(),
        input.wallet_address.toLowerCase(),
        input.address_type,
        input.is_contract,
        input.tx_hash,
        input.log_index,
        input.block_number,
        input.block_time,
        input.trade_type,
        input.side ?? null,
        input.token_amount ?? '0',
        input.quote_amount ?? '0',
        input.amount_usd ?? 0,
        input.price ?? 0,
        input.balance_after ?? null,
        input.quote_balance_after ?? null,
        input.staking_balance_after ?? null,
        input.buy_count_after ?? 0,
        input.sell_count_after ?? 0,
        input.from_address?.toLowerCase() ?? null,
        input.to_address?.toLowerCase() ?? null,
        input.pair_address?.toLowerCase() ?? null,
        input.contract_address?.toLowerCase() ?? null,
      ],
    );
    return n > 0;
  } catch {
    return false;
  }
}

export async function listTokenTransactions(
  tokenAddress: string,
  opts: {
    trade_types?: string[];
    wallet?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = Math.min(200, opts.pageSize ?? 50);
  const offset = (page - 1) * pageSize;
  const conditions = ['chain_id = ?', 'token_address = ?'];
  const params: unknown[] = [CHAIN_ID, tokenAddress.toLowerCase()];
  if (opts.trade_types?.length) {
    conditions.push(`trade_type IN (${opts.trade_types.map(() => '?').join(',')})`);
    params.push(...opts.trade_types);
  }
  if (opts.wallet) {
    conditions.push('wallet_address = ?');
    params.push(opts.wallet.toLowerCase());
  }
  const where = conditions.join(' AND ');
  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM token_transactions WHERE ${where}`,
    params,
  );
  const total = totalRow?.c ?? 0;
  const items = await dbAll<Record<string, unknown>>(
    `SELECT * FROM token_transactions WHERE ${where} ORDER BY block_time DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  return { items, total };
}
