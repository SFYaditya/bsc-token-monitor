import { dbGet, dbRun } from '../pg/query.js';
import { CHAIN_ID, WHALE_RULE } from '../../config.js';
import type { EventType } from '../../lifecycle.js';
import type { AddressTokenProfile } from '../../types.js';
import { getHolderProfile } from './holderProfileRepo.js';
import { getTokenMarket } from './marketRepo.js';
import { getTokenLpStakingStat, resolveLpUsdFields } from '../../services/catLpStaking.js';
import { computePnl } from '../../services/pnl.js';
import { getLabels } from './labelRepo.js';

export async function applyEventToStat(
  tokenAddress: string,
  wallet: string,
  eventType: EventType,
  tokenAmount: bigint,
  quoteValueUsd: number,
  eventTime: number,
): Promise<Record<string, unknown> | undefined> {
  const token = tokenAddress.toLowerCase();
  const w = wallet.toLowerCase();
  const existing = await dbGet<Record<string, unknown>>(
    'SELECT * FROM token_address_stat WHERE chain_id = ? AND token_address = ? AND wallet_address = ?',
    [CHAIN_ID, token, w],
  );

  if (!existing) {
    await dbRun(
      `INSERT INTO token_address_stat (
        chain_id, token_address, wallet_address, buy_count, sell_count,
        transfer_in_count, transfer_out_count, total_buy_token, total_sell_token,
        total_buy_value, total_sell_value, last_trade_time
      ) VALUES (?, ?, ?, 0, 0, 0, 0, '0', '0', 0, 0, ?)`,
      [CHAIN_ID, token, w, eventTime],
    );
  }

  if (eventType === 'buy') {
    const prev = BigInt(String(existing?.total_buy_token ?? '0'));
    const nextTok = (prev + tokenAmount).toString();
    await dbRun(
      `UPDATE token_address_stat SET
        buy_count = buy_count + 1,
        total_buy_token = ?,
        total_buy_value = total_buy_value + ?,
        last_trade_time = ?,
        last_buy_time = ?,
        first_buy_time = COALESCE(first_buy_time, ?),
        is_cleared = 0
      WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
      [nextTok, quoteValueUsd, eventTime, eventTime, eventTime, CHAIN_ID, token, w],
    );
  } else if (eventType === 'sell') {
    const prev = BigInt(String(existing?.total_sell_token ?? '0'));
    const nextTok = (prev + tokenAmount).toString();
    await dbRun(
      `UPDATE token_address_stat SET
        sell_count = sell_count + 1,
        total_sell_token = ?,
        total_sell_value = total_sell_value + ?,
        last_trade_time = ?,
        last_sell_time = ?,
        is_cleared = 0
      WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
      [nextTok, quoteValueUsd, eventTime, eventTime, CHAIN_ID, token, w],
    );
  }

  if (eventType === 'buy' || eventType === 'sell') {
    return dbGet<Record<string, unknown>>(
      'SELECT * FROM token_address_stat WHERE chain_id = ? AND token_address = ? AND wallet_address = ?',
      [CHAIN_ID, token, w],
    );
  }
  return existing;
}

export async function bumpTransferStat(
  tokenAddress: string,
  from: string,
  to: string,
  eventTime: number,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const fromL = from.toLowerCase();
  const toL = to.toLowerCase();
  await ensureStatRow(token, fromL, eventTime);
  await ensureStatRow(token, toL, eventTime);
  await dbRun(
    `UPDATE token_address_stat SET transfer_out_count = transfer_out_count + 1, last_trade_time = ?
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [eventTime, CHAIN_ID, token, fromL],
  );
  await dbRun(
    `UPDATE token_address_stat SET transfer_in_count = transfer_in_count + 1, last_trade_time = ?
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [eventTime, CHAIN_ID, token, toL],
  );
}

async function ensureStatRow(token: string, wallet: string, eventTime: number): Promise<void> {
  await dbRun(
    `INSERT INTO token_address_stat (
      chain_id, token_address, wallet_address, last_trade_time
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT (chain_id, token_address, wallet_address) DO NOTHING`,
    [CHAIN_ID, token, wallet, eventTime],
  );
}

export async function updateStatBalance(
  tokenAddress: string,
  wallet: string,
  balance: string,
  isCleared: boolean,
): Promise<void> {
  await dbRun(
    `UPDATE token_address_stat SET current_balance = ?, is_cleared = ?
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [balance, isCleared ? 1 : 0, CHAIN_ID, tokenAddress.toLowerCase(), wallet.toLowerCase()],
  );
}

export async function countHolders(tokenAddress: string): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const { collectExcludedHolderAddresses } = await import('../../token/holderExclude.js');
  const excluded = [...(await collectExcludedHolderAddresses(token))];
  let sql = `SELECT COUNT(*)::int AS c FROM token_holder
             WHERE chain_id = ? AND token_address = ? AND balance != '0' AND balance != ''`;
  const params: unknown[] = [CHAIN_ID, token];
  if (excluded.length) {
    sql += ` AND holder_address NOT IN (${excluded.map(() => '?').join(',')})`;
    params.push(...excluded);
  }
  const row = await dbGet<{ c: number }>(sql, params);
  return row?.c ?? 0;
}

export async function getAddressProfile(
  tokenAddress: string,
  walletAddress: string,
  priceUsd = 0,
  tokenDecimals = 18,
): Promise<AddressTokenProfile | null> {
  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();
  const scale = 10 ** tokenDecimals;

  const holder = await dbGet<{ balance: string; balance_percent: number }>(
    `SELECT balance, balance_percent FROM token_holder WHERE chain_id = ? AND token_address = ? AND holder_address = ?`,
    [CHAIN_ID, token, wallet],
  );

  const stat = await dbGet<Record<string, unknown>>(
    'SELECT * FROM token_address_stat WHERE chain_id = ? AND token_address = ? AND wallet_address = ?',
    [CHAIN_ID, token, wallet],
  );

  if (!holder && !stat) return null;

  const balance = String(holder?.balance ?? stat?.current_balance ?? '0');
  const balanceNum = Number(balance);
  const buyAmt = BigInt(String(stat?.total_buy_token ?? '0'));
  const sellAmt = BigInt(String(stat?.total_sell_token ?? '0'));
  const netAmt = buyAmt >= sellAmt ? buyAmt - sellAmt : 0n;
  const totalBuyUsd = Number(stat?.total_buy_value ?? 0);
  const totalSellUsd = Number(stat?.total_sell_value ?? 0);
  const balanceUsd = (balanceNum / scale) * priceUsd;
  const holdingPct = Number(holder?.balance_percent ?? 0);
  const isWhale =
    balanceUsd >= WHALE_RULE.minHoldingUsd ||
    holdingPct >= WHALE_RULE.minHoldingPercent;

  const avgBuy = buyAmt > 0n ? totalBuyUsd / (Number(buyAmt) / scale) : 0;
  const avgSell = sellAmt > 0n ? totalSellUsd / (Number(sellAmt) / scale) : 0;
  const pnl = computePnl({
    balanceRaw: BigInt(balance),
    totalBuyToken: buyAmt,
    totalSellToken: sellAmt,
    totalBuyUsd,
    totalSellUsd,
    priceUsd,
    tokenDecimals,
  });
  const labels = (await getLabels(token, wallet)).map((l) => l.label);
  const hp = await getHolderProfile(token, wallet);
  const market = await getTokenMarket(token);
  const lpStat = await getTokenLpStakingStat(token);
  const lpUsd = resolveLpUsdFields(
    hp?.lp_balance ?? '0',
    hp?.lp_staked_balance ?? '0',
    market?.liquidityUsd ?? 0,
    String(lpStat?.total_lp_supply ?? '0'),
  );

  return {
    tokenAddress: token,
    walletAddress: wallet,
    walletBalance: balance,
    stakingBalance: String(stat?.staking_balance ?? '0'),
    lpBalanceRaw: hp?.lp_balance ?? '0',
    lpStakedBalanceRaw: hp?.lp_staked_balance ?? '0',
    lpBalanceUsd: lpUsd.lpBalanceUsd,
    lpStakedBalanceUsd: lpUsd.lpStakedBalanceUsd,
    balancePercent: holdingPct,
    buyCount: Number(stat?.buy_count ?? 0),
    sellCount: Number(stat?.sell_count ?? 0),
    totalBuyAmount: String(stat?.total_buy_token ?? '0'),
    totalBuyUsd: totalBuyUsd,
    totalSellAmount: String(stat?.total_sell_token ?? '0'),
    totalSellUsd: totalSellUsd,
    netBuyAmount: netAmt.toString(),
    netBuyUsd: totalBuyUsd - totalSellUsd,
    avgBuyPrice: avgBuy,
    avgSellPrice: avgSell,
    unrealizedPnl: pnl.unrealizedPnl,
    realizedPnl: pnl.realizedPnl,
    totalPnl: pnl.totalPnl,
    roi: pnl.roi,
    firstBuyTime: stat?.first_buy_time != null ? Number(stat.first_buy_time) : undefined,
    lastTradeTime: stat?.last_trade_time != null ? Number(stat.last_trade_time) : undefined,
    isCleared: !!(stat?.is_cleared ?? balance === '0'),
    isWhale,
    isBot: labels.includes('bot'),
    isSmartMoney: labels.includes('smart_money'),
    isProject: labels.includes('project'),
    isContract: false,
    labels,
  };
}
