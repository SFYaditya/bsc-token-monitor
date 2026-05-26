import { dbAll, dbGet } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';

/** 有买卖行为的地址汇总（用于买卖地址记录页） */
export async function listTraders(
  tokenAddress: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const token = tokenAddress.toLowerCase();
  const page = opts.page ?? 1;
  const pageSize = Math.min(500, opts.pageSize ?? 100);
  const offset = (page - 1) * pageSize;

  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM token_address_stat
     WHERE chain_id = ? AND token_address = ? AND (buy_count > 0 OR sell_count > 0)`,
    [CHAIN_ID, token],
  );
  const total = totalRow?.c ?? 0;

  const items = await dbAll<Record<string, unknown>>(
    `SELECT s.wallet_address, s.buy_count, s.sell_count,
            s.total_buy_token, s.total_sell_token,
            s.total_buy_value, s.total_sell_value,
            s.current_balance, s.last_trade_time, s.first_buy_time,
            h.balance, h.balance_percent, h.address_tag
     FROM token_address_stat s
     LEFT JOIN token_holder h ON h.chain_id = s.chain_id AND h.token_address = s.token_address AND h.holder_address = s.wallet_address
     WHERE s.chain_id = ? AND s.token_address = ? AND (s.buy_count > 0 OR s.sell_count > 0)
     ORDER BY s.last_trade_time IS NULL, s.last_trade_time DESC
     LIMIT ? OFFSET ?`,
    [CHAIN_ID, token, pageSize, offset],
  );

  return { items, total };
}
