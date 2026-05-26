import { ZeroAddress } from 'ethers';
import { CHAIN_ID } from '../config.js';
import { dbGet } from '../db/pg/query.js';
import { calcBalancePercent } from '../token/balanceMath.js';
import { deleteHolder, getHolderBalance, upsertHolder } from '../db/repos/holderRepo.js';
import { updateStatBalance } from '../db/repos/statRepo.js';
import { markHolderForCalibration } from './holderCalibration.js';
import { setHolderBalanceSource } from './holderBalanceSource.js';

const ZERO = ZeroAddress.toLowerCase();

async function persistHolderBalanceDelta(
  token: string,
  wallet: string,
  next: bigint,
  totalSupplyRaw: string,
): Promise<string> {
  const supply = BigInt(totalSupplyRaw || '0');
  if (next <= 0n) {
    deleteHolder(token, wallet);
    updateStatBalance(token, wallet, '0', true);
    return '0';
  }
  const pct = calcBalancePercent(next, supply);
  const balance = next.toString();
  upsertHolder({
    token_address: token,
    holder_address: wallet,
    balance,
    balance_percent: pct,
    last_active_time: Date.now(),
  });
  updateStatBalance(token, wallet, balance, false);
  await markHolderForCalibration(token, wallet);
  void setHolderBalanceSource(token, wallet, 'EVENT_ESTIMATED', Date.now());
  return balance;
}

/** 同一笔 Swap 对应的 Pair Transfer 是否已入库（slow_transfer 可能晚于 fast_pair） */
export async function pairTransferRecordedForSwap(input: {
  tokenAddress: string;
  trader: string;
  txHash: string;
  pairAddress: string;
}): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  const trader = input.trader.toLowerCase();
  const pair = input.pairAddress.toLowerCase();
  const row = await dbGet<{ ok: number }>(
    `SELECT 1 AS ok FROM token_event
     WHERE chain_id = ? AND token_address = ? AND tx_hash = ? AND event_type = 'transfer'
       AND (
         (LOWER(from_address) = ? AND LOWER(to_address) = ?)
         OR (LOWER(from_address) = ? AND LOWER(to_address) = ?)
       )
     LIMIT 1`,
    [CHAIN_ID, token, input.txHash, trader, pair, pair, trader],
  );
  return !!row?.ok;
}

/**
 * Swap 后钱包持仓：若 Pair Transfer 尚未处理，按买卖方向增量估算并写回 holder。
 * 解决 fast_pair Swap 先于 slow_transfer 时 TG/交易记录展示卖出前余额的问题。
 */
export async function resolveSwapHolderBalanceAfterTrade(input: {
  tokenAddress: string;
  trader: string;
  tradeType: 'buy' | 'sell';
  tokenAmount: bigint;
  txHash: string;
  pairAddress: string;
  totalSupply: string;
}): Promise<string> {
  const token = input.tokenAddress.toLowerCase();
  const trader = input.trader.toLowerCase();
  const current = BigInt((await getHolderBalance(token, trader)) ?? '0');
  if (
    await pairTransferRecordedForSwap({
      tokenAddress: token,
      trader,
      txHash: input.txHash,
      pairAddress: input.pairAddress,
    })
  ) {
    return current.toString();
  }
  const next =
    input.tradeType === 'buy'
      ? current + input.tokenAmount
      : current > input.tokenAmount
        ? current - input.tokenAmount
        : 0n;
  return persistHolderBalanceDelta(token, trader, next, input.totalSupply);
}

/** Transfer 事件增量调整本地持仓（不调用 balanceOf） */
export async function applyIncrementalTransfer(
  tokenAddress: string,
  from: string,
  to: string,
  value: bigint,
  totalSupplyRaw: string,
  pairAddress?: string,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const pair = pairAddress?.toLowerCase() ?? '';
  const fromL = from.toLowerCase();
  const toL = to.toLowerCase();

  const adjust = async (wallet: string, delta: bigint) => {
    if (!wallet || wallet === ZERO || (pair && wallet === pair)) return;
    const prev = BigInt((await getHolderBalance(token, wallet)) ?? '0');
    await persistHolderBalanceDelta(token, wallet, prev + delta, totalSupplyRaw);
  };

  if (fromL !== ZERO && fromL !== pair) {
    await adjust(fromL, -value);
  }
  if (toL !== ZERO && toL !== pair) {
    await adjust(toL, value);
  }
}
