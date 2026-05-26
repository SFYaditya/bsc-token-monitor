import { dbAll, dbGet, dbRun } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import type { BalanceSource } from '../../services/holderBalanceSource.js';
import type { AddressGrading, BehaviorTagId, HoldingTierId } from '../../services/whaleGrading.js';
import { bigintTextOrderSql, balanceUsdFromRaw } from '../../token/balanceMath.js';
import { collectExcludedHolderAddresses } from '../../token/holderExclude.js';

export interface HolderProfileRow {
  chain_id: number;
  token_address: string;
  wallet_address: string;
  wallet_balance: string;
  staking_balance: string;
  lp_balance: string;
  lp_staked_balance: string;
  is_lp_staking_user: number;
  total_balance: string;
  balance_usd: number;
  holding_percent: number;
  buy_count: number;
  sell_count: number;
  total_buy_amount: string;
  total_buy_usd: string;
  total_sell_amount: string;
  total_sell_usd: string;
  net_buy_amount: string;
  net_buy_usd: string;
  avg_buy_price: string;
  avg_sell_price: string;
  realized_pnl: string;
  unrealized_pnl: string;
  total_pnl: string;
  roi: string;
  first_buy_time: number | null;
  last_trade_time: number | null;
  highest_balance: string;
  highest_balance_usd: string;
  is_whale: number;
  is_super_whale: number;
  is_staking_user: number;
  is_cleared: number;
  is_new_wallet: number;
  holder_level: HoldingTierId;
  liquidity_impact: string;
  behavior_tags: string;
  updated_at: number;
}

function bigintSub(a: string, b: string): string {
  const v = BigInt(a || '0') - BigInt(b || '0');
  return v >= 0n ? v.toString() : '0';
}

export async function upsertHolderProfile(input: {
  token_address: string;
  wallet_address: string;
  wallet_balance: string;
  staking_balance: string;
  balance_percent: number;
  stat: Record<string, unknown> | null;
  grading: AddressGrading | null;
  pnl: {
    avgBuyPrice: number;
    avgSellPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
    totalPnl: number;
    roi: number;
  };
  is_new_wallet?: boolean;
  address_type?: string;
  is_contract?: number;
  price_usd?: number;
  token_decimals?: number;
  balance_source?: BalanceSource;
  last_balance_checked_at?: number | null;
  lp_balance?: string;
  lp_staked_balance?: string;
}): Promise<void> {
  const token = input.token_address.toLowerCase();
  const wallet = input.wallet_address.toLowerCase();
  const walletBal = BigInt(input.wallet_balance || '0');
  const stakeBal = BigInt(input.staking_balance || '0');

  const existingLp = await dbGet<{ lp_balance: string; lp_staked_balance: string }>(
    `SELECT lp_balance, lp_staked_balance FROM holder_profiles
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, token, wallet],
  );
  const lpBal = BigInt(
    input.lp_balance !== undefined
      ? input.lp_balance || '0'
      : existingLp?.lp_balance ?? '0',
  );
  const lpStaked = BigInt(
    input.lp_staked_balance !== undefined
      ? input.lp_staked_balance || '0'
      : existingLp?.lp_staked_balance ?? '0',
  );
  const totalBal = walletBal + stakeBal;
  const stat = input.stat;
  const g = input.grading;

  const totalBuyAmt = String(stat?.total_buy_token ?? '0');
  const totalSellAmt = String(stat?.total_sell_token ?? '0');
  const totalBuyUsd = Number(stat?.total_buy_value ?? 0);
  const totalSellUsd = Number(stat?.total_sell_value ?? 0);
  const netBuyAmt = bigintSub(totalBuyAmt, totalSellAmt);
  const netBuyUsd = (totalBuyUsd - totalSellUsd).toFixed(6);

  const existing = await dbGet<{ highest_balance: string }>(
    `SELECT highest_balance FROM holder_profiles
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, token, wallet],
  );
  const prevPeak = BigInt(existing?.highest_balance ?? '0');
  const peak = totalBal > prevPeak ? totalBal : prevPeak;
  const balanceUsd =
    (input.price_usd ?? 0) > 0
      ? balanceUsdFromRaw(totalBal, input.token_decimals ?? 18, input.price_usd ?? 0)
      : (g?.holdingUsd ?? 0);
  const peakUsd =
    balanceUsd > 0 && totalBal > 0n
      ? (Number(peak) / Number(totalBal)) * balanceUsd
      : balanceUsd;

  const behaviorTags: BehaviorTagId[] = g?.behaviorTags ?? [];
  const now = Date.now();
  const isWhale = g?.holdingTier === 'whale' || g?.holdingTier === 'super_whale' ? 1 : 0;
  const isSuper = g?.holdingTier === 'super_whale' ? 1 : 0;
  const isStaking =
    stakeBal > 0n || behaviorTags.includes('staking_whale') ? 1 : 0;
  const isLpStaking = lpStaked > 0n ? 1 : 0;
  const isCleared = behaviorTags.includes('cleared') ? 1 : 0;

  await dbRun(
    `INSERT INTO holder_profiles (
      chain_id, token_address, wallet_address,
      wallet_balance, staking_balance, total_balance, balance_usd, holding_percent,
      buy_count, sell_count,
      total_buy_amount, total_buy_usd, total_sell_amount, total_sell_usd,
      net_buy_amount, net_buy_usd,
      avg_buy_price, avg_sell_price, realized_pnl, unrealized_pnl, total_pnl, roi,
      first_buy_time, last_buy_time, last_sell_time, last_trade_time, highest_balance, highest_balance_usd,
      is_contract, address_type, is_whale, is_super_whale, is_staking_user, is_lp_staking_user,
      is_cleared, is_new_wallet,
      holder_level, liquidity_impact, behavior_tags, risk_tags,
      lp_balance, lp_staked_balance,
      last_balance_checked_at, balance_source, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, COALESCE(?, 'EVENT_ESTIMATED'), ?
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
      first_buy_time = COALESCE(holder_profiles.first_buy_time, EXCLUDED.first_buy_time),
      last_buy_time = EXCLUDED.last_buy_time,
      last_sell_time = EXCLUDED.last_sell_time,
      last_trade_time = EXCLUDED.last_trade_time,
      address_type = EXCLUDED.address_type,
      is_contract = EXCLUDED.is_contract,
      highest_balance = EXCLUDED.highest_balance,
      highest_balance_usd = EXCLUDED.highest_balance_usd,
      is_whale = EXCLUDED.is_whale,
      is_super_whale = EXCLUDED.is_super_whale,
      is_staking_user = EXCLUDED.is_staking_user,
      is_lp_staking_user = EXCLUDED.is_lp_staking_user,
      lp_balance = EXCLUDED.lp_balance,
      lp_staked_balance = EXCLUDED.lp_staked_balance,
      is_cleared = EXCLUDED.is_cleared,
      is_new_wallet = EXCLUDED.is_new_wallet,
      holder_level = EXCLUDED.holder_level,
      liquidity_impact = EXCLUDED.liquidity_impact,
      behavior_tags = EXCLUDED.behavior_tags,
      last_balance_checked_at = COALESCE(EXCLUDED.last_balance_checked_at, holder_profiles.last_balance_checked_at),
      balance_source = COALESCE(EXCLUDED.balance_source, holder_profiles.balance_source, 'EVENT_ESTIMATED'),
      updated_at = EXCLUDED.updated_at`,
    [
      CHAIN_ID,
      token,
      wallet,
      walletBal.toString(),
      stakeBal.toString(),
      totalBal.toString(),
      balanceUsd,
      input.balance_percent,
      Number(stat?.buy_count ?? 0),
      Number(stat?.sell_count ?? 0),
      totalBuyAmt,
      totalBuyUsd.toFixed(6),
      totalSellAmt,
      totalSellUsd.toFixed(6),
      netBuyAmt,
      netBuyUsd,
      String(input.pnl.avgBuyPrice),
      String(input.pnl.avgSellPrice),
      String(input.pnl.realizedPnl),
      String(input.pnl.unrealizedPnl),
      String(input.pnl.totalPnl),
      String(input.pnl.roi),
      stat?.first_buy_time != null ? Number(stat.first_buy_time) : null,
      stat?.last_buy_time != null
        ? Number(stat.last_buy_time)
        : stat?.first_buy_time != null
          ? Number(stat.first_buy_time)
          : null,
      stat?.last_sell_time != null ? Number(stat.last_sell_time) : null,
      stat?.last_trade_time != null ? Number(stat.last_trade_time) : null,
      peak.toString(),
      peakUsd.toFixed(6),
      input.is_contract ?? 0,
      input.address_type ?? 'wallet',
      isWhale,
      isSuper,
      isStaking,
      isLpStaking,
      isCleared,
      input.is_new_wallet ? 1 : 0,
      g?.holdingTier ?? 'small',
      g?.liquidityImpact ?? 'low',
      JSON.stringify(behaviorTags),
      lpBal.toString(),
      lpStaked.toString(),
      input.last_balance_checked_at ?? null,
      input.balance_source ?? null,
      now,
    ],
  );
}

/** 按当前市价回写 holder_profiles.balance_usd */
export async function refreshHolderProfileBalanceUsd(
  tokenAddress: string,
  priceUsd: number,
  decimals: number,
): Promise<number> {
  if (priceUsd <= 0) return 0;
  const token = tokenAddress.toLowerCase();
  const rows = await dbAll<{ wallet_address: string; total_balance: string }>(
    `SELECT wallet_address, total_balance FROM holder_profiles
     WHERE chain_id = ? AND token_address = ? AND total_balance != '0'`,
    [CHAIN_ID, token],
  );
  const now = Date.now();
  for (const row of rows) {
    const usd = balanceUsdFromRaw(row.total_balance, decimals, priceUsd);
    await dbRun(
      `UPDATE holder_profiles SET balance_usd = ?, updated_at = ?
       WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
      [usd, now, CHAIN_ID, token, row.wallet_address.toLowerCase()],
    );
  }
  return rows.length;
}

export async function getHolderProfile(
  tokenAddress: string,
  walletAddress: string,
): Promise<HolderProfileRow | null> {
  const row = (await dbGet(
    `SELECT * FROM holder_profiles WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, tokenAddress.toLowerCase(), walletAddress.toLowerCase()],
  )) as HolderProfileRow | undefined;
  return row ?? null;
}

export type HolderProfileSortBy =
  | 'holding_usd'
  | 'balance'
  | 'buy_count'
  | 'sell_count'
  | 'net_buy'
  | 'last_trade_time';

function holderProfileOrderBy(sortBy: HolderProfileSortBy, sortDir: 'asc' | 'desc'): string {
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';
  const bal = bigintTextOrderSql('total_balance', sortDir);
  const net = bigintTextOrderSql('net_buy_amount', sortDir);
  switch (sortBy) {
    case 'holding_usd':
      return `ORDER BY balance_usd ${dir}, LENGTH(total_balance) DESC, total_balance DESC`;
    case 'balance':
      return bal;
    case 'buy_count':
      return `ORDER BY buy_count ${dir}`;
    case 'sell_count':
      return `ORDER BY sell_count ${dir}`;
    case 'net_buy':
      return net;
    case 'last_trade_time':
      return `ORDER BY (last_trade_time IS NULL), last_trade_time ${dir}`;
    default:
      return `ORDER BY balance_usd DESC, LENGTH(total_balance) DESC, total_balance DESC`;
  }
}

export async function listHolderProfiles(
  tokenAddress: string,
  opts: {
    filter?: string;
    page?: number;
    pageSize?: number;
    sortBy?: HolderProfileSortBy;
    sortDir?: 'asc' | 'desc';
  } = {},
): Promise<{ items: HolderProfileRow[]; total: number }> {
  const token = tokenAddress.toLowerCase();
  const page = opts.page ?? 1;
  const pageSize = Math.min(500, opts.pageSize ?? 100);
  const offset = (page - 1) * pageSize;

  let where = `chain_id = ? AND token_address = ? AND total_balance != '0' AND total_balance != ''
    AND EXISTS (
      SELECT 1 FROM token_holder th
      WHERE th.token_address = holder_profiles.token_address
        AND th.holder_address = holder_profiles.wallet_address
        AND th.balance IS NOT NULL AND th.balance != '0' AND th.balance != ''
    )`;
  const params: unknown[] = [CHAIN_ID, token];

  const excluded = [...(await collectExcludedHolderAddresses(token))];
  if (excluded.length) {
    where += ` AND wallet_address NOT IN (${excluded.map(() => '?').join(',')})`;
    params.push(...excluded);
  }

  const filter = opts.filter ?? 'all';
  if (filter === 'whale') {
    where += ` AND holder_level IN ('whale', 'super_whale')`;
  } else if (filter === 'super_whale') {
    where += ` AND holder_level = 'super_whale'`;
  } else if (filter === 'accumulating') {
    where += ` AND behavior_tags LIKE '%accumulating%'`;
  } else if (filter === 'reducing') {
    where += ` AND behavior_tags LIKE '%reducing%'`;
  } else if (filter === 'staking') {
    where += ` AND (is_staking_user = 1 OR behavior_tags LIKE '%staking_whale%')`;
  } else if (filter === 'lp_staking') {
    where += ` AND (is_lp_staking_user = 1 OR CAST(lp_staked_balance AS NUMERIC) > 0)`;
  } else if (filter === 'cleared') {
    where += ` AND behavior_tags LIKE '%cleared%'`;
  } else if (filter === 'new_buy') {
    const since = Date.now() - 24 * 60 * 60_000;
    where += ` AND first_buy_time >= ?`;
    params.push(since);
  } else if (filter === 'high_impact') {
    where += ` AND liquidity_impact IN ('high', 'extreme')`;
  }

  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM holder_profiles WHERE ${where}`,
    params,
  );
  const total = totalRow?.c ?? 0;

  const sortBy = opts.sortBy ?? 'balance';
  const sortDir = opts.sortDir ?? 'desc';
  const orderBy = holderProfileOrderBy(sortBy, sortDir);

  const items = (await dbAll(
    `SELECT * FROM holder_profiles WHERE ${where}
     ${orderBy} LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  )) as unknown as HolderProfileRow[];

  return { items, total };
}
