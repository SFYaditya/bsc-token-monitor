import { CHAIN_ID } from '../../config.js';
import { isPostgresEnabled, pgExec } from '../pg.js';

function toPgPlaceholders(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

/** 异步镜像写入 PostgreSQL，不阻塞 SQLite 主路径 */
export function pgMirror(sql: string, params: unknown[]): void {
  if (!isPostgresEnabled()) return;
  const pgSql = toPgPlaceholders(sql);
  void pgExec(pgSql, params).catch((err) => {
    console.error('[PG mirror]', err instanceof Error ? err.message : err);
  });
}

export function mirrorTokenEvent(input: {
  token_address: string;
  event_type: string;
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
}): void {
  pgMirror(
    `INSERT INTO token_event (
      chain_id, token_address, event_type, tx_hash, log_index, block_number, event_time,
      from_address, to_address, trader, token_amount, quote_amount, price, pair_address, amount_usd, balance_after
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (tx_hash, log_index, token_address) DO NOTHING`,
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
    ],
  );
}

export function mirrorRawEvent(input: {
  token_address?: string;
  contract_address: string;
  event_name: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: number;
  from_address?: string;
  to_address?: string;
  decoded_data?: Record<string, unknown>;
  process_status?: string;
  processed?: number;
}): void {
  const now = Date.now();
  pgMirror(
    `INSERT INTO raw_events (
      chain_id, token_address, contract_address, event_name, tx_hash, log_index,
      block_number, block_time, decoded_data, from_address, to_address,
      processed, process_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
    [
      CHAIN_ID,
      input.token_address?.toLowerCase() ?? null,
      input.contract_address.toLowerCase(),
      input.event_name,
      input.tx_hash,
      input.log_index,
      input.block_number,
      input.block_time,
      input.decoded_data ? JSON.stringify(input.decoded_data) : null,
      input.from_address?.toLowerCase() ?? null,
      input.to_address?.toLowerCase() ?? null,
      input.processed ?? 0,
      input.process_status ?? 'pending',
      now,
    ],
  );
}

export function mirrorRawEventStatus(
  txHash: string,
  logIndex: number,
  status: 'ok' | 'failed',
  error?: string,
): void {
  pgMirror(
    `UPDATE raw_events SET processed = 1, process_status = ?, error_message = ?
     WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
    [status === 'ok' ? 'ok' : 'failed', error ?? null, CHAIN_ID, txHash, logIndex],
  );
}

export function mirrorMarketCache(row: {
  token_address: string;
  symbol: string;
  price_usd: number;
  price_change_5m: number;
  price_change_15m: number;
  price_change_1h: number;
  price_change_24h: number;
  high_24h: number;
  low_24h: number;
  volume_24h_usd: number;
  liquidity_usd: number;
  token_reserve: string;
  quote_reserve: string;
  holder_count: number;
  updated_at: number;
}): void {
  pgMirror(
    `INSERT INTO token_market_cache (
      token_address, symbol, price_usd, price_change_5m, price_change_15m, price_change_1h,
      price_change_24h, high_24h, low_24h, volume_24h_usd, liquidity_usd,
      token_reserve, quote_reserve, holder_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (token_address) DO UPDATE SET
      symbol = EXCLUDED.symbol,
      price_usd = EXCLUDED.price_usd,
      price_change_5m = EXCLUDED.price_change_5m,
      price_change_15m = EXCLUDED.price_change_15m,
      price_change_1h = EXCLUDED.price_change_1h,
      price_change_24h = EXCLUDED.price_change_24h,
      high_24h = EXCLUDED.high_24h,
      low_24h = EXCLUDED.low_24h,
      volume_24h_usd = EXCLUDED.volume_24h_usd,
      liquidity_usd = EXCLUDED.liquidity_usd,
      token_reserve = EXCLUDED.token_reserve,
      quote_reserve = EXCLUDED.quote_reserve,
      holder_count = EXCLUDED.holder_count,
      updated_at = EXCLUDED.updated_at`,
    [
      row.token_address.toLowerCase(),
      row.symbol,
      row.price_usd,
      row.price_change_5m,
      row.price_change_15m,
      row.price_change_1h,
      row.price_change_24h,
      row.high_24h,
      row.low_24h,
      row.volume_24h_usd,
      row.liquidity_usd,
      row.token_reserve,
      row.quote_reserve,
      row.holder_count,
      row.updated_at,
    ],
  );
}

export function mirrorHolderProfile(row: Record<string, unknown>): void {
  pgMirror(
    `INSERT INTO holder_profiles (
      chain_id, token_address, wallet_address, wallet_balance, staking_balance, total_balance,
      balance_usd, holding_percent, buy_count, sell_count, total_buy_amount, total_buy_usd,
      total_sell_amount, total_sell_usd, net_buy_amount, net_buy_usd, avg_buy_price, avg_sell_price,
      realized_pnl, unrealized_pnl, total_pnl, roi, first_buy_time, last_trade_time,
      highest_balance, highest_balance_usd, is_contract, is_whale, is_super_whale, is_staking_user,
      is_cleared, is_new_wallet, holder_level, liquidity_impact, behavior_tags, risk_tags, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT (chain_id, token_address, wallet_address) DO UPDATE SET
      wallet_balance = EXCLUDED.wallet_balance,
      staking_balance = EXCLUDED.staking_balance,
      total_balance = EXCLUDED.total_balance,
      balance_usd = EXCLUDED.balance_usd,
      holding_percent = EXCLUDED.holding_percent,
      buy_count = EXCLUDED.buy_count,
      sell_count = EXCLUDED.sell_count,
      total_buy_amount = EXCLUDED.total_buy_amount,
      total_buy_usd = EXCLUDED.total_buy_usd,
      total_sell_amount = EXCLUDED.total_sell_amount,
      total_sell_usd = EXCLUDED.total_sell_usd,
      net_buy_amount = EXCLUDED.net_buy_amount,
      net_buy_usd = EXCLUDED.net_buy_usd,
      avg_buy_price = EXCLUDED.avg_buy_price,
      avg_sell_price = EXCLUDED.avg_sell_price,
      realized_pnl = EXCLUDED.realized_pnl,
      unrealized_pnl = EXCLUDED.unrealized_pnl,
      total_pnl = EXCLUDED.total_pnl,
      roi = EXCLUDED.roi,
      first_buy_time = EXCLUDED.first_buy_time,
      last_trade_time = EXCLUDED.last_trade_time,
      highest_balance = EXCLUDED.highest_balance,
      highest_balance_usd = EXCLUDED.highest_balance_usd,
      is_contract = EXCLUDED.is_contract,
      is_whale = EXCLUDED.is_whale,
      is_super_whale = EXCLUDED.is_super_whale,
      is_staking_user = EXCLUDED.is_staking_user,
      is_cleared = EXCLUDED.is_cleared,
      is_new_wallet = EXCLUDED.is_new_wallet,
      holder_level = EXCLUDED.holder_level,
      liquidity_impact = EXCLUDED.liquidity_impact,
      behavior_tags = EXCLUDED.behavior_tags,
      risk_tags = EXCLUDED.risk_tags,
      updated_at = EXCLUDED.updated_at`,
    [
      row.chain_id ?? CHAIN_ID,
      String(row.token_address).toLowerCase(),
      String(row.wallet_address).toLowerCase(),
      row.wallet_balance,
      row.staking_balance,
      row.total_balance,
      row.balance_usd,
      row.holding_percent,
      row.buy_count,
      row.sell_count,
      row.total_buy_amount,
      row.total_buy_usd,
      row.total_sell_amount,
      row.total_sell_usd,
      row.net_buy_amount,
      row.net_buy_usd,
      row.avg_buy_price,
      row.avg_sell_price,
      row.realized_pnl,
      row.unrealized_pnl,
      row.total_pnl,
      row.roi,
      row.first_buy_time ?? null,
      row.last_trade_time ?? null,
      row.highest_balance,
      row.highest_balance_usd,
      row.is_contract,
      row.is_whale,
      row.is_super_whale,
      row.is_staking_user,
      row.is_cleared,
      row.is_new_wallet,
      row.holder_level,
      row.liquidity_impact,
      row.behavior_tags,
      row.risk_tags,
      row.updated_at,
    ],
  );
}
