import { ALERT_LARGE_TRADE_USD, WHALE_RULE, CHAIN_ID } from '../config.js';
import { dbGet, dbAll } from '../db/pg/query.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getHolderBalance } from '../db/repos/holderRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { getMonitorToken } from '../monitorTokens.js';
import { tradePriceUsdFromEvent } from '../market/tradePrice.js';
import { dispatchAlert } from './alertDispatcher.js';
import { getPrimaryLabel } from './addressClassifier.js';
import { getWalletRemark } from '../db/repos/addressRemarkRepo.js';
import { formatShortAddress } from '../util/addressFormat.js';
import { resolveTradeSizeLabel } from '../trade/tradeSizeLabel.js';

function formatAlertUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatAlertPrice(priceUsd: number): string {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return '—';
  return `$${priceUsd.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
}

function formatAlertTokenQty(raw: string, decimals: number): string {
  let n: number;
  try {
    const v = BigInt(raw || '0');
    n = Number(v) / 10 ** decimals;
  } catch {
    n = Number(raw) / 10 ** decimals;
  }
  if (!Number.isFinite(n)) return '0.0000';
  return n.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

/** 自然日零点（默认 UTC+8，可用 TRADE_ALERT_DAY_UTC_OFFSET_HOURS 覆盖） */
export function startOfTradeAlertDayMs(now = Date.now()): number {
  const offsetHours = Number(process.env.TRADE_ALERT_DAY_UTC_OFFSET_HOURS ?? 8);
  const offsetMs = offsetHours * 60 * 60 * 1000;
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.floor((now + offsetMs) / dayMs) * dayMs - offsetMs;
}

export async function getWalletDayTradeTokenTotals(
  tokenAddress: string,
  wallet: string,
  sinceMs: number,
): Promise<{ buyTokens: bigint; sellTokens: bigint }> {
  const token = tokenAddress.toLowerCase();
  const w = wallet.toLowerCase();
  const rows = (await dbAll(
    `SELECT event_type, COALESCE(SUM(CAST(token_amount AS NUMERIC)), 0)::text AS tokens
     FROM token_event
     WHERE chain_id = ? AND token_address = ? AND trader = ? AND event_time >= ?
       AND event_type IN ('buy', 'sell')
     GROUP BY event_type`,
    [CHAIN_ID, token, w, sinceMs],
  )) as { event_type: string; tokens: string }[];

  let buyTokens = 0n;
  let sellTokens = 0n;
  for (const row of rows) {
    const v = BigInt(String(row.tokens ?? '0'));
    if (row.event_type === 'buy') buyTokens = v;
    else if (row.event_type === 'sell') sellTokens = v;
  }
  return { buyTokens, sellTokens };
}

export async function resolveTraderAlertLabel(
  tokenAddress: string,
  walletAddress: string,
): Promise<string> {
  const remark = await getWalletRemark(tokenAddress, walletAddress);
  if (remark) return remark;
  return formatShortAddress(walletAddress);
}

export function formatTradeTelegramMessage(input: {
  tradeType: 'buy' | 'sell';
  symbol: string;
  tokenAmount: string;
  decimals: number;
  amountUsd: number;
  priceUsd: number;
  traderLabel: string;
  buyCount: number;
  sellCount: number;
  holdingBalance: string;
  todayBuyTokens: string;
  todaySellTokens: string;
}): string {
  const isBuy = input.tradeType === 'buy';
  const qty = formatAlertTokenQty(input.tokenAmount, input.decimals);
  const hold = formatAlertTokenQty(input.holdingBalance, input.decimals);
  const todayBuy = formatAlertTokenQty(input.todayBuyTokens, input.decimals);
  const todaySell = formatAlertTokenQty(input.todaySellTokens, input.decimals);
  const usd = formatAlertUsd(input.amountUsd);
  const price = formatAlertPrice(input.priceUsd);
  const sizeLabel = resolveTradeSizeLabel(input.amountUsd);
  return [
    isBuy ? `🟢 买入 · ${sizeLabel}` : `🔴 卖出 · ${sizeLabel}`,
    `${input.symbol} · ${qty}（${usd}）`,
    `价格：${price}`,
    `地址：${input.traderLabel}`,
    `买/卖：${input.buyCount} / ${input.sellCount}`,
    `持仓：${hold}`,
    `今日已买入：${todayBuy}`,
    `今日已卖出：${todaySell}`,
  ].join('\n');
}

export async function maybeAlertLargeTrade(input: {
  tokenAddress: string;
  tradeType: 'buy' | 'sell';
  trader: string;
  amountUsd: number;
  tokenAmount: string;
  decimals: number;
  price?: number;
  txHash: string;
  pairAddress?: string;
  symbol?: string;
  buyCount?: number;
  sellCount?: number;
  holdingBalance?: string;
  priceUsd?: number;
}): Promise<void> {
  const contract = input.symbol ? null : await getContract(input.tokenAddress);
  const symbol =
    input.symbol ?? contract?.token_symbol ?? input.tokenAddress.slice(0, 8);
  const isBuy = input.tradeType === 'buy';
  const trader = input.trader.toLowerCase();
  const token = input.tokenAddress.toLowerCase();
  const tokenCfg = getMonitorToken(token);
  const notifyAllBuys = tokenCfg?.notifyBuyTelegram === true;
  const notifyAllSells = tokenCfg?.notifySellTelegram === true;
  const buyThreshold = notifyAllBuys
    ? 0
    : tokenCfg?.alertLargeTradeUsd != null && Number.isFinite(tokenCfg.alertLargeTradeUsd)
      ? tokenCfg.alertLargeTradeUsd
      : ALERT_LARGE_TRADE_USD;
  const sellThreshold = notifyAllSells
    ? 0
    : tokenCfg?.alertLargeTradeUsd != null && Number.isFinite(tokenCfg.alertLargeTradeUsd)
      ? tokenCfg.alertLargeTradeUsd
      : ALERT_LARGE_TRADE_USD;
  const tradeThreshold = isBuy ? buyThreshold : sellThreshold;

  const meetsBuyAlert = isBuy && notifyAllBuys && input.amountUsd > 0;
  const meetsSellAlert = !isBuy && notifyAllSells && input.amountUsd > 0;
  if (meetsBuyAlert || meetsSellAlert || input.amountUsd >= tradeThreshold) {
    const alertType = isBuy ? 'large_buy' : 'large_sell';
    const level = input.amountUsd >= tradeThreshold * 5 ? 'HIGH' : 'MEDIUM';
    const stat =
      input.buyCount != null && input.sellCount != null
        ? { buy_count: input.buyCount, sell_count: input.sellCount }
        : await dbGet<{ buy_count: number; sell_count: number }>(
            `SELECT buy_count, sell_count FROM token_address_stat
       WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
            [CHAIN_ID, token, trader],
          );
    const holdingBalance =
      input.holdingBalance ?? (await getHolderBalance(token, trader)) ?? '0';
    const market = input.priceUsd != null ? null : await getTokenMarket(token);
    const priceUsd =
      input.priceUsd ??
      tradePriceUsdFromEvent(
        input.amountUsd,
        input.tokenAmount,
        input.decimals,
        input.price ?? market?.priceUsd ?? 0,
      );
    const dayStart = startOfTradeAlertDayMs();
    const todayTotals = await getWalletDayTradeTokenTotals(token, trader, dayStart);
    const traderLabel = await resolveTraderAlertLabel(token, trader);
    await dispatchAlert({
      alert_type: alertType,
      token_address: token,
      pair_address: input.pairAddress,
      tx_hash: input.txHash,
      wallet_address: trader,
      amount_usd: input.amountUsd,
      level,
      message: formatTradeTelegramMessage({
        tradeType: input.tradeType,
        symbol,
        tokenAmount: input.tokenAmount,
        decimals: input.decimals,
        amountUsd: input.amountUsd,
        priceUsd,
        traderLabel,
        buyCount: Number(stat?.buy_count ?? 0),
        sellCount: Number(stat?.sell_count ?? 0),
        holdingBalance,
        todayBuyTokens: todayTotals.buyTokens.toString(),
        todaySellTokens: todayTotals.sellTokens.toString(),
      }),
    });
  }

  if (input.amountUsd >= WHALE_RULE.minSingleTradeUsd) {
    const label = await getPrimaryLabel(input.tokenAddress, trader);
    if (label === 'whale' || input.amountUsd >= WHALE_RULE.minHoldingUsd) {
      await dispatchAlert({
        alert_type: isBuy ? 'whale_buy' : 'whale_sell',
        token_address: input.tokenAddress,
        tx_hash: input.txHash,
        wallet_address: trader,
        amount_usd: input.amountUsd,
        level: 'HIGH',
        message: `🐋 巨鲸${isBuy ? '买入' : '卖出'}\n${symbol} · ${formatAlertUsd(input.amountUsd)}`,
      });
    }
  }

  if (!isBuy) {
    const label = await getPrimaryLabel(input.tokenAddress, trader);
    if (label === 'project') {
      await dispatchAlert({
        alert_type: 'project_sell',
        token_address: input.tokenAddress,
        tx_hash: input.txHash,
        wallet_address: trader,
        amount_usd: input.amountUsd,
        level: 'CRITICAL',
        message: `🚨 项目方/团队地址卖出\n${symbol} · ${formatAlertUsd(input.amountUsd)}\n${trader}`,
      });
    }
  }
}
