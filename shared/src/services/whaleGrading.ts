import { dbAll, dbGet } from '../db/pg/query.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { balanceUsdFromRaw } from '../token/balanceMath.js';
import {
  canonicalLpStakedRaw,
  getLpStakingConfig,
  getTokenLpStakingStat,
  resolveLpUsdFields,
  sumLpStakedByWallets,
} from './catLpStaking.js';
import { isExcludedHolderAddress } from '../token/holderExclude.js';
import {
  listHolderProfiles,
  refreshHolderProfileBalanceUsd,
} from '../db/repos/holderProfileRepo.js';
export type HoldingTierId =
  | 'small'
  | 'normal'
  | 'large'
  | 'whale'
  | 'super_whale';

export type LiquidityImpactId = 'low' | 'medium' | 'high' | 'extreme';

export type BehaviorTagId =
  | 'new_whale'
  | 'accumulating'
  | 'reducing'
  | 'cleared'
  | 'long_term_holder'
  | 'short_term_arbitrage'
  | 'staking_whale'
  | 'unstake_watch';

export const HOLDING_TIER_LABELS: Record<HoldingTierId, string> = {
  small: '小额地址',
  normal: '普通持仓',
  large: '大额持仓',
  whale: '巨鲸地址',
  super_whale: '超级巨鲸',
};

export const LIQUIDITY_IMPACT_LABELS: Record<LiquidityImpactId, string> = {
  low: '低影响',
  medium: '中等影响',
  high: '高影响',
  extreme: '极高影响',
};

export const BEHAVIOR_TAG_LABELS: Record<BehaviorTagId, string> = {
  new_whale: '新晋巨鲸',
  accumulating: '持续加仓',
  reducing: '正在减仓',
  cleared: '已清仓',
  long_term_holder: '长期持有',
  short_term_arbitrage: '短线套利',
  staking_whale: '质押巨鲸',
  unstake_watch: '解押观察',
};

const WHALE_TIER_USD = 10_000;
const MS_24H = 24 * 60 * 60_000;
const MS_7D = 7 * 24 * 60 * 60_000;

export interface AddressGrading {
  walletAddress: string;
  balanceRaw: string;
  holdingUsd: number;
  holdingTier: HoldingTierId;
  holdingTierLabel: string;
  liquidityImpact: LiquidityImpactId;
  liquidityImpactLabel: string;
  liquidityImpactPct: number;
  behaviorTags: BehaviorTagId[];
  behaviorTagLabels: string[];
  stakingBalanceRaw: string;
  lpBalanceRaw?: string;
  lpStakedBalanceRaw?: string;
  lpBalanceUsd?: number;
  lpStakedBalanceUsd?: number;
}

export type HolderRankingFilter =
  | 'all'
  | 'whale'
  | 'super_whale'
  | 'accumulating'
  | 'reducing'
  | 'staking'
  | 'lp_staking'
  | 'cleared'
  | 'new_buy'
  | 'high_impact';

export interface HolderRankingItem extends AddressGrading {
  rank: number;
  balance_percent: number;
  buy_count: number;
  sell_count: number;
  address_tag?: string | null;
  first_buy_time?: number | null;
  address_type?: string;
  is_contract?: boolean;
  total_buy_amount?: string;
  total_sell_amount?: string;
  net_buy_amount?: string;
  net_buy_usd?: string;
  last_trade_time?: number | null;
}

export function getHoldingTier(holdingUsd: number): HoldingTierId {
  if (holdingUsd < 500) return 'small';
  if (holdingUsd < 2_000) return 'normal';
  if (holdingUsd < 10_000) return 'large';
  if (holdingUsd < 50_000) return 'whale';
  return 'super_whale';
}

/** 无链上价格时按占总供应量比例分级（用于 CAT 等无 Pair 代币） */
export function getHoldingTierByPercent(supplyPercent: number): HoldingTierId {
  if (supplyPercent < 0.01) return 'small';
  if (supplyPercent < 0.1) return 'normal';
  if (supplyPercent < 1) return 'large';
  if (supplyPercent < 5) return 'whale';
  return 'super_whale';
}

export function getLiquidityImpact(
  holdingUsd: number,
  liquidityUsd: number,
): { id: LiquidityImpactId; pct: number } {
  if (liquidityUsd <= 0) return { id: 'low', pct: 0 };
  const pct = (holdingUsd / liquidityUsd) * 100;
  if (pct < 1) return { id: 'low', pct };
  if (pct < 3) return { id: 'medium', pct };
  if (pct < 10) return { id: 'high', pct };
  return { id: 'extreme', pct };
}

interface HolderRow {
  holder_address: string;
  balance: string;
  balance_percent?: number;
  buy_count?: number;
  sell_count?: number;
  total_buy_token?: string;
  total_sell_token?: string;
  total_buy_value?: number;
  total_sell_value?: number;
  first_buy_time?: number;
  staking_balance?: string;
}

function rawToUsd(balanceRaw: bigint, decimals: number, priceUsd: number): number {
  return (Number(balanceRaw) / 10 ** decimals) * priceUsd;
}

async function getTradeStats24h(token: string, wallet: string, since: number) {
  const rows = (await dbAll(
    `SELECT event_type, COUNT(*)::int AS c,
            COALESCE(SUM(amount_usd), 0)::float AS usd,
            COALESCE(SUM(CAST(token_amount AS NUMERIC)), 0)::text AS tokens
     FROM token_event
     WHERE token_address = ? AND trader = ? AND event_time >= ?
       AND event_type IN ('buy', 'sell')
     GROUP BY event_type`,
    [token, wallet, since],
  )) as {
      event_type: string;
      c: number;
      usd: number;
      tokens: number;
    }[];

  let buyCount = 0;
  let sellCount = 0;
  let buyUsd = 0;
  let sellUsd = 0;
  let buyTokens = 0n;
  let sellTokens = 0n;
  for (const r of rows) {
    if (r.event_type === 'buy') {
      buyCount = r.c;
      buyUsd = Number(r.usd);
      buyTokens = BigInt(String(r.tokens ?? 0));
    } else if (r.event_type === 'sell') {
      sellCount = r.c;
      sellUsd = Number(r.usd);
      sellTokens = BigInt(String(r.tokens ?? 0));
    }
  }
  return { buyCount, sellCount, buyUsd, sellUsd, buyTokens, sellTokens };
}

async function getPeakBalanceRaw(token: string, wallet: string, current: bigint): Promise<bigint> {
  const row = await dbGet<{ peak: string | null }>(
    `SELECT MAX(CAST(balance_after AS NUMERIC))::text AS peak
     FROM token_event
     WHERE token_address = ? AND trader = ? AND balance_after IS NOT NULL AND balance_after != ''`,
    [token, wallet],
  );
  const peak = BigInt(String(row?.peak ?? 0));
  return peak > current ? peak : current;
}

async function getMaxHoldingUsdBefore(
  token: string,
  wallet: string,
  beforeMs: number,
  decimals: number,
  priceUsd: number,
): Promise<number> {
  const row = await dbGet<{ peak: string | null }>(
    `SELECT MAX(CAST(balance_after AS NUMERIC))::text AS peak
     FROM token_event
     WHERE token_address = ? AND trader = ? AND event_time < ?
       AND balance_after IS NOT NULL AND balance_after != ''`,
    [token, wallet, beforeMs],
  );
  return rawToUsd(BigInt(String(row?.peak ?? 0)), decimals, priceUsd);
}

async function getUnstake24hRaw(token: string, wallet: string, since: number): Promise<bigint> {
  const row = await dbGet<{ v: string }>(
    `SELECT COALESCE(SUM(CAST(amount AS NUMERIC)), 0)::text AS v
     FROM staking_record
     WHERE token_address = ? AND wallet_address = ? AND action = 'unstake' AND event_time >= ?`,
    [token, wallet, since],
  );
  return BigInt(String(row?.v ?? 0));
}

export async function computeBehaviorTags(input: {
  token: string;
  wallet: string;
  balanceRaw: bigint;
  stakingRaw: bigint;
  holdingUsd: number;
  holdingTier: HoldingTierId;
  decimals: number;
  priceUsd: number;
  row: HolderRow;
  now?: number;
}): Promise<BehaviorTagId[]> {
  const now = input.now ?? Date.now();
  const since24h = now - MS_24H;
  const tags: BehaviorTagId[] = [];
  const { buyCount, sellCount, buyUsd, sellUsd, buyTokens, sellTokens } = await getTradeStats24h(
    input.token,
    input.wallet,
    since24h,
  );

  const isWhaleTierNow =
    input.holdingTier === 'whale' || input.holdingTier === 'super_whale';

  if (isWhaleTierNow) {
    const maxUsdBefore = await getMaxHoldingUsdBefore(
      input.token,
      input.wallet,
      since24h,
      input.decimals,
      input.priceUsd,
    );
    if (maxUsdBefore < WHALE_TIER_USD) {
      tags.push('new_whale');
    }
  }

  if (buyCount >= 3 && buyUsd > sellUsd) {
    tags.push('accumulating');
  }

  if (sellCount >= 3 && sellUsd > buyUsd) {
    tags.push('reducing');
  }

  const peak = await getPeakBalanceRaw(input.token, input.wallet, input.balanceRaw);
  if (peak > 0n && input.balanceRaw * 100n < peak * 5n) {
    tags.push('cleared');
  }

  const firstBuy = input.row.first_buy_time != null ? Number(input.row.first_buy_time) : null;
  const totalBuy = BigInt(String(input.row.total_buy_token ?? '0'));
  const totalSell = BigInt(String(input.row.total_sell_token ?? '0'));
  if (firstBuy && firstBuy <= now - MS_7D) {
    const sellRatio = totalBuy > 0n ? Number(totalSell) / Number(totalBuy) : 0;
    if (sellRatio < 0.1) {
      tags.push('long_term_holder');
    }
  }

  if (buyTokens > 0n && sellTokens > 0n && sellTokens * 2n > buyTokens) {
    tags.push('short_term_arbitrage');
  }

  const walletBal = input.balanceRaw;
  const stakeBal = input.stakingRaw;
  const totalHold = walletBal + stakeBal;
  if (totalHold > 0n && stakeBal * 2n >= totalHold) {
    tags.push('staking_whale');
  }

  const unstake24h = await getUnstake24hRaw(input.token, input.wallet, since24h);
  if (totalHold > 0n && unstake24h * 10n >= totalHold * 3n) {
    tags.push('unstake_watch');
  }

  return tags;
}

async function gradeHolderRow(
  token: string,
  row: HolderRow,
  priceUsd: number,
  liquidityUsd: number,
  dec: number,
): Promise<AddressGrading | null> {
  const wallet = String(row.holder_address).toLowerCase();
  const balanceRaw = BigInt(String(row.balance ?? '0'));
  if (balanceRaw <= 0n) return null;

  const stakingRaw = BigInt(String(row.staking_balance ?? '0'));
  const holdingUsd = rawToUsd(balanceRaw, dec, priceUsd);
  const supplyPct = Number(row.balance_percent ?? 0);
  const holdingTier =
    priceUsd > 0 ? getHoldingTier(holdingUsd) : getHoldingTierByPercent(supplyPct);
  const liq =
    priceUsd > 0 && liquidityUsd > 0
      ? getLiquidityImpact(holdingUsd, liquidityUsd)
      : { id: 'low' as LiquidityImpactId, pct: supplyPct };
  const behaviorTags = await computeBehaviorTags({
    token,
    wallet,
    balanceRaw,
    stakingRaw,
    holdingUsd,
    holdingTier,
    decimals: dec,
    priceUsd,
    row,
  });

  return {
    walletAddress: wallet,
    balanceRaw: balanceRaw.toString(),
    holdingUsd,
    holdingTier,
    holdingTierLabel: HOLDING_TIER_LABELS[holdingTier],
    liquidityImpact: liq.id,
    liquidityImpactLabel: LIQUIDITY_IMPACT_LABELS[liq.id],
    liquidityImpactPct: liq.pct,
    behaviorTags,
    behaviorTagLabels: behaviorTags.map((t) => BEHAVIOR_TAG_LABELS[t]),
    stakingBalanceRaw: stakingRaw.toString(),
  };
}

export function matchesHolderRankingFilter(
  item: AddressGrading & { first_buy_time?: number | null },
  filter: HolderRankingFilter,
  now = Date.now(),
): boolean {
  if (filter === 'all') return true;
  if (filter === 'whale') {
    return item.holdingTier === 'whale' || item.holdingTier === 'super_whale';
  }
  if (filter === 'super_whale') return item.holdingTier === 'super_whale';
  if (filter === 'accumulating') return item.behaviorTags.includes('accumulating');
  if (filter === 'reducing') return item.behaviorTags.includes('reducing');
  if (filter === 'staking') {
    return (
      item.behaviorTags.includes('staking_whale') ||
      BigInt(item.stakingBalanceRaw || '0') > 0n
    );
  }
  if (filter === 'cleared') return item.behaviorTags.includes('cleared');
  if (filter === 'new_buy') {
    const t = item.first_buy_time != null ? Number(item.first_buy_time) : 0;
    return t > 0 && t >= now - MS_24H;
  }
  return true;
}

export type HolderRankingSortBy =
  | 'holding_usd'
  | 'balance'
  | 'buy_count'
  | 'sell_count'
  | 'net_buy'
  | 'last_trade_time';

function compareRankingItems(
  a: HolderRankingItem,
  b: HolderRankingItem,
  sortBy: HolderRankingSortBy,
  sortDir: 'asc' | 'desc',
): number {
  const sign = sortDir === 'asc' ? 1 : -1;
  const cmpNum = (x: number, y: number) => (x > y ? 1 : x < y ? -1 : 0);
  const cmpBig = (x: string, y: string) => {
    const bx = BigInt(x || '0');
    const by = BigInt(y || '0');
    if (bx > by) return 1;
    if (bx < by) return -1;
    return 0;
  };
  let c = 0;
  switch (sortBy) {
    case 'holding_usd':
      c = cmpNum(a.holdingUsd, b.holdingUsd);
      if (c === 0) c = cmpBig(a.balanceRaw, b.balanceRaw);
      break;
    case 'balance':
      c = cmpBig(a.balanceRaw, b.balanceRaw);
      break;
    case 'buy_count':
      c = cmpNum(a.buy_count, b.buy_count);
      break;
    case 'sell_count':
      c = cmpNum(a.sell_count, b.sell_count);
      break;
    case 'net_buy':
      c = cmpBig(a.net_buy_amount ?? '0', b.net_buy_amount ?? '0');
      break;
    case 'last_trade_time': {
      const ta = a.last_trade_time ?? 0;
      const tb = b.last_trade_time ?? 0;
      if (ta === 0 && tb === 0) c = 0;
      else if (ta === 0) c = 1;
      else if (tb === 0) c = -1;
      else c = ta > tb ? 1 : ta < tb ? -1 : 0;
      break;
    }
    default:
      c = cmpBig(a.balanceRaw, b.balanceRaw);
  }
  return c * sign;
}

export async function defaultHolderRankingSort(tokenAddress: string): Promise<{
  sortBy: HolderRankingSortBy;
  sortDir: 'asc' | 'desc';
  hasMarket: boolean;
}> {
  const market = await getTokenMarket(tokenAddress.toLowerCase());
  const hasMarket = (market?.priceUsd ?? 0) > 0;
  return {
    hasMarket,
    sortBy: hasMarket ? 'holding_usd' : 'balance',
    sortDir: 'desc',
  };
}

export async function listHolderRanking(
  tokenAddress: string,
  opts: {
    filter?: HolderRankingFilter;
    page?: number;
    pageSize?: number;
    minHoldingUsd?: number;
    sortBy?: HolderRankingSortBy;
    sortDir?: 'asc' | 'desc';
  } = {},
): Promise<{
  items: HolderRankingItem[];
  total: number;
  filter: HolderRankingFilter;
  sortBy: HolderRankingSortBy;
  sortDir: 'asc' | 'desc';
  hasMarket: boolean;
}> {
  const token = tokenAddress.toLowerCase();
  const filter = opts.filter ?? 'all';
  const page = opts.page ?? 1;
  const pageSize = Math.min(500, opts.pageSize ?? 100);
  const minUsd = opts.minHoldingUsd ?? 0;
  const defaults = await defaultHolderRankingSort(token);
  const sortBy = opts.sortBy ?? defaults.sortBy;
  const sortDir = opts.sortDir ?? defaults.sortDir;

  const market = await getTokenMarket(token);
  const priceUsd = market?.priceUsd ?? 0;
  const liquidityUsd = market?.liquidityUsd ?? 0;
  const contractRow = await getContract(token);
  const dec = contractRow?.token_decimals ?? 18;
  let profiled = await listHolderProfiles(token, {
    filter,
    page,
    pageSize,
    sortBy,
    sortDir,
  });
  if (
    profiled.total > 0 &&
    priceUsd > 0 &&
    profiled.items.every((row) => (row.balance_usd ?? 0) <= 0)
  ) {
    await refreshHolderProfileBalanceUsd(token, priceUsd, dec);
    profiled = await listHolderProfiles(token, { filter, page, pageSize, sortBy, sortDir });
  }
  if (profiled.total > 0) {
    const lpStat = await getTokenLpStakingStat(token);
    const totalLpSupply = String(lpStat?.total_lp_supply ?? '0');
    const lpCfg = getLpStakingConfig(token);
    const recordStaked = lpCfg
      ? await sumLpStakedByWallets(
          token,
          profiled.items.map((r) => String(r.wallet_address)),
        )
      : new Map<string, bigint>();
    const items: HolderRankingItem[] = profiled.items
      .filter((row) => {
        const usd =
          row.balance_usd > 0
            ? row.balance_usd
            : balanceUsdFromRaw(row.total_balance, dec, priceUsd);
        return usd >= minUsd;
      })
      .map((row, i) => {
        const tags = JSON.parse(row.behavior_tags || '[]') as BehaviorTagId[];
        const holdingUsd =
          row.balance_usd > 0
            ? row.balance_usd
            : balanceUsdFromRaw(row.total_balance, dec, priceUsd);
        const lpStakedRaw = canonicalLpStakedRaw(
          String(row.wallet_address),
          row.lp_staked_balance ?? '0',
          recordStaked,
        );
        const lpUsd = resolveLpUsdFields(
          row.lp_balance ?? '0',
          lpStakedRaw,
          liquidityUsd,
          totalLpSupply,
        );
        return {
          walletAddress: row.wallet_address,
          balanceRaw: row.total_balance,
          holdingUsd,
          holdingTier: row.holder_level as HoldingTierId,
          holdingTierLabel: HOLDING_TIER_LABELS[row.holder_level as HoldingTierId] ?? row.holder_level,
          liquidityImpact: row.liquidity_impact as LiquidityImpactId,
          liquidityImpactLabel:
            LIQUIDITY_IMPACT_LABELS[row.liquidity_impact as LiquidityImpactId] ?? row.liquidity_impact,
          liquidityImpactPct: 0,
          behaviorTags: tags,
          behaviorTagLabels: tags.map((t) => BEHAVIOR_TAG_LABELS[t]),
          stakingBalanceRaw: row.staking_balance,
          lpBalanceRaw: row.lp_balance ?? '0',
          lpStakedBalanceRaw: lpStakedRaw,
          lpBalanceUsd: lpUsd.lpBalanceUsd,
          lpStakedBalanceUsd: lpUsd.lpStakedBalanceUsd,
          rank: (page - 1) * pageSize + i + 1,
          balance_percent: row.holding_percent,
          buy_count: row.buy_count,
          sell_count: row.sell_count,
          address_tag: null,
          first_buy_time: row.first_buy_time,
          address_type: (row as { address_type?: string }).address_type ?? 'wallet',
          is_contract: Number((row as { is_contract?: number }).is_contract ?? 0) === 1,
          total_buy_amount: row.total_buy_amount,
          total_sell_amount: row.total_sell_amount,
          net_buy_amount: row.net_buy_amount,
          net_buy_usd: row.net_buy_usd,
          last_trade_time: row.last_trade_time,
        };
      });
    return {
      items,
      total: profiled.total,
      filter,
      sortBy,
      sortDir,
      hasMarket: priceUsd > 0,
    };
  }

  const rows = (await dbAll(
    `SELECT h.holder_address, h.balance, h.balance_percent, h.address_tag,
            s.buy_count, s.sell_count, s.total_buy_token, s.total_sell_token,
            s.total_buy_value, s.total_sell_value, s.first_buy_time, s.staking_balance
     FROM token_holder h
     LEFT JOIN token_address_stat s
       ON s.token_address = h.token_address AND s.wallet_address = h.holder_address
     WHERE h.token_address = ? AND h.balance != '0' AND h.balance != ''`,
    [token],
  )) as unknown as (HolderRow & { address_tag?: string | null })[];

  const ranked: HolderRankingItem[] = [];
  for (const row of rows) {
    if (await isExcludedHolderAddress(token, String(row.holder_address))) continue;
    const graded = await gradeHolderRow(token, row, priceUsd, liquidityUsd, dec);
    if (!graded) continue;
    if (graded.holdingUsd < minUsd) continue;
    if (
      !matchesHolderRankingFilter(
        { ...graded, first_buy_time: row.first_buy_time },
        filter,
      )
    ) {
      continue;
    }
    ranked.push({
      ...graded,
      rank: 0,
      balance_percent: Number(row.balance_percent ?? 0),
      buy_count: Number(row.buy_count ?? 0),
      sell_count: Number(row.sell_count ?? 0),
      address_tag: row.address_tag ?? null,
      first_buy_time: row.first_buy_time != null ? Number(row.first_buy_time) : null,
    });
  }

  ranked.sort((a, b) => compareRankingItems(a, b, sortBy, sortDir));
  const total = ranked.length;
  const offset = (page - 1) * pageSize;
  const slice = ranked.slice(offset, offset + pageSize).map((item, i) => ({
    ...item,
    rank: offset + i + 1,
  }));
  return {
    items: slice,
    total,
    filter,
    sortBy,
    sortDir,
    hasMarket: priceUsd > 0,
  };
}

export async function computeAddressGrading(
  tokenAddress: string,
  walletAddress: string,
  priceUsd: number,
  liquidityUsd: number,
  decimals?: number,
): Promise<AddressGrading | null> {
  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();
  const contract = await getContract(token);
  const dec = decimals ?? contract?.token_decimals ?? 18;

  const row = (await dbGet(
    `SELECT h.holder_address, h.balance, h.balance_percent,
            s.buy_count, s.sell_count, s.total_buy_token, s.total_sell_token,
            s.total_buy_value, s.total_sell_value, s.first_buy_time, s.staking_balance
     FROM token_holder h
     LEFT JOIN token_address_stat s
       ON s.token_address = h.token_address AND s.wallet_address = h.holder_address
     WHERE h.token_address = ? AND h.holder_address = ? AND h.balance != '0'`,
    [token, wallet],
  )) as HolderRow | undefined;

  if (!row) return null;
  return gradeHolderRow(token, row, priceUsd, liquidityUsd, dec);
}

export async function listGradedWhaleAddresses(
  tokenAddress: string,
  opts: { minHoldingUsd?: number; limit?: number } = {},
): Promise<AddressGrading[]> {
  const minUsd = opts.minHoldingUsd ?? 500;
  const limit = Math.min(500, opts.limit ?? 200);
  const { items } = await listHolderRanking(tokenAddress, {
    filter: 'all',
    page: 1,
    pageSize: limit,
    minHoldingUsd: minUsd,
  });
  return items.sort((a, b) => b.holdingUsd - a.holdingUsd);
}
