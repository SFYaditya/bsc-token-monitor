import { dbAll } from '../db/pg/query.js';
import { WHALE_RULE } from '../config.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { computeAddressGrading, type HoldingTierId } from './whaleGrading.js';

const MS_24H = 24 * 60 * 60_000;

const WHALE_ALERT_TYPES = new Set([
  'whale_buy',
  'whale_sell',
  'whale_first_buy',
  'unstake_then_sell',
  'large_buy',
  'large_sell',
]);

export type WhaleActivityKind =
  | 'whale_buy'
  | 'whale_sell'
  | 'whale_first_buy'
  | 'large_buy'
  | 'large_sell'
  | 'whale_clear'
  | 'stake'
  | 'unstake'
  | 'unstake_then_sell';

export const WHALE_ACTIVITY_LABELS: Record<WhaleActivityKind, string> = {
  whale_buy: '巨鲸买入',
  whale_sell: '巨鲸卖出',
  whale_first_buy: '巨鲸首次买入',
  large_buy: '大额买入',
  large_sell: '大额卖出',
  whale_clear: '巨鲸清仓',
  stake: '巨鲸质押',
  unstake: '巨鲸解押',
  unstake_then_sell: '解押后卖出',
};

export interface WhaleActivityItem {
  id: string;
  kind: WhaleActivityKind;
  kindLabel: string;
  walletAddress: string;
  amountUsd: number;
  tokenAmount: string;
  txHash: string;
  eventTime: number;
  holdingTier?: HoldingTierId;
  holdingTierLabel?: string;
  message?: string;
}

function isWhaleTier(tier: HoldingTierId | undefined): boolean {
  return tier === 'whale' || tier === 'super_whale';
}

export async function listWhaleActivity(
  tokenAddress: string,
  opts: { limit?: number; sinceMs?: number } = {},
): Promise<{ items: WhaleActivityItem[]; total: number }> {
  const token = tokenAddress.toLowerCase();
  const since = Date.now() - (opts.sinceMs ?? MS_24H);
  const limit = Math.min(200, opts.limit ?? 80);
  const market = await getTokenMarket(token);
  const priceUsd = market?.priceUsd ?? 0;
  const liquidityUsd = market?.liquidityUsd ?? 0;
  const contract = await getContract(token);
  const dec = contract?.token_decimals ?? 18;
  const minTrade = WHALE_RULE.minSingleTradeUsd;

  const tierCache = new Map<string, Awaited<ReturnType<typeof computeAddressGrading>>>();

  async function gradingFor(wallet: string) {
    const w = wallet.toLowerCase();
    if (!tierCache.has(w)) {
      tierCache.set(
        w,
        await computeAddressGrading(token, w, priceUsd, liquidityUsd, dec),
      );
    }
    return tierCache.get(w) ?? null;
  }

  const items: WhaleActivityItem[] = [];
  const seen = new Set<string>();

  function push(item: WhaleActivityItem) {
    const key = `${item.kind}:${item.txHash}:${item.walletAddress}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  }

  const alerts = await dbAll<{
    alert_type: string;
    wallet_address: string | null;
    tx_hash: string | null;
    amount_usd: number | null;
    message: string | null;
    created_at: number;
  }>(
    `SELECT alert_type, wallet_address, tx_hash, amount_usd, message, created_at
     FROM alert_log
     WHERE token_address = ? AND created_at >= ?
       AND alert_type IN (${[...WHALE_ALERT_TYPES].map(() => '?').join(',')})
     ORDER BY created_at DESC LIMIT 120`,
    [token, since, ...WHALE_ALERT_TYPES],
  );

  for (const a of alerts) {
    const wallet = String(a.wallet_address ?? '').toLowerCase();
    if (!wallet) continue;
    const g = await gradingFor(wallet);
    const kind = a.alert_type as WhaleActivityKind;
    if (!WHALE_ALERT_TYPES.has(kind)) continue;
    if (kind.startsWith('large_') && !isWhaleTier(g?.holdingTier)) continue;
    push({
      id: `alert:${a.created_at}:${wallet}:${kind}`,
      kind,
      kindLabel: WHALE_ACTIVITY_LABELS[kind] ?? kind,
      walletAddress: wallet,
      amountUsd: Number(a.amount_usd ?? 0),
      tokenAmount: '0',
      txHash: String(a.tx_hash ?? ''),
      eventTime: Number(a.created_at),
      holdingTier: g?.holdingTier,
      holdingTierLabel: g?.holdingTierLabel,
      message: a.message ?? undefined,
    });
  }

  const trades = await dbAll<{
    event_type: string;
    trader: string;
    token_amount: string;
    amount_usd: number;
    tx_hash: string;
    event_time: number;
  }>(
    `SELECT event_type, trader, token_amount, amount_usd, tx_hash, event_time
     FROM token_event
     WHERE token_address = ? AND event_time >= ?
       AND event_type IN ('buy', 'sell')
       AND amount_usd >= ?
     ORDER BY event_time DESC LIMIT 150`,
    [token, since, minTrade],
  );

  for (const t of trades) {
    const wallet = String(t.trader ?? '').toLowerCase();
    if (!wallet) continue;
    const g = await gradingFor(wallet);
    const whaleTrade =
      isWhaleTier(g?.holdingTier) || Number(t.amount_usd) >= WHALE_RULE.minHoldingUsd;
    if (!whaleTrade) continue;

    let kind: WhaleActivityKind =
      t.event_type === 'buy' ? 'whale_buy' : 'whale_sell';
    if (Number(t.amount_usd) >= minTrade * 3 && !isWhaleTier(g?.holdingTier)) {
      kind = t.event_type === 'buy' ? 'large_buy' : 'large_sell';
    }
    if (t.event_type === 'sell' && g?.behaviorTags.includes('cleared')) {
      kind = 'whale_clear';
    }

    push({
      id: `trade:${t.tx_hash}:${wallet}:${kind}`,
      kind,
      kindLabel: WHALE_ACTIVITY_LABELS[kind],
      walletAddress: wallet,
      amountUsd: Number(t.amount_usd ?? 0),
      tokenAmount: String(t.token_amount ?? '0'),
      txHash: String(t.tx_hash),
      eventTime: Number(t.event_time),
      holdingTier: g?.holdingTier,
      holdingTierLabel: g?.holdingTierLabel,
    });
  }

  const stakes = await dbAll<{
    wallet_address: string;
    action: string;
    amount: string;
    tx_hash: string;
    event_time: number;
  }>(
    `SELECT wallet_address, action, amount, tx_hash, event_time
     FROM staking_record
     WHERE token_address = ? AND event_time >= ?
     ORDER BY event_time DESC LIMIT 80`,
    [token, since],
  );

  for (const s of stakes) {
    const wallet = String(s.wallet_address).toLowerCase();
    const g = await gradingFor(wallet);
    if (!isWhaleTier(g?.holdingTier) && !g?.behaviorTags.includes('staking_whale')) {
      continue;
    }
    const action = String(s.action);
    if (action !== 'stake' && action !== 'unstake') continue;
    const kind: WhaleActivityKind = action === 'stake' ? 'stake' : 'unstake';
    const amountRaw = BigInt(String(s.amount ?? '0'));
    const amountUsd = (Number(amountRaw) / 10 ** dec) * priceUsd;
    push({
      id: `stake:${s.tx_hash}:${wallet}:${kind}`,
      kind,
      kindLabel: WHALE_ACTIVITY_LABELS[kind],
      walletAddress: wallet,
      amountUsd,
      tokenAmount: String(s.amount),
      txHash: String(s.tx_hash),
      eventTime: Number(s.event_time),
      holdingTier: g?.holdingTier,
      holdingTierLabel: g?.holdingTierLabel,
    });
  }

  items.sort((a, b) => b.eventTime - a.eventTime);
  const slice = items.slice(0, limit);
  return { items: slice, total: items.length };
}
