import type { Provider } from 'ethers';
import { dbGet } from '../db/pg/query.js';
import {
  insertEvent,
  shouldSkipChainEvent,
  eventExists,
  hasSwapEvent,
  updateContractStatus,
  applyEventToStat,
  bumpTransferStat,
  syncHolderBalance,
  syncPairSideBalances,
  getPairByToken,
  fetchWbnbUsd,
  swapQuoteUsd,
  maybeAlertLargeTrade,
  fetchTokenMeta,
  getMonitorToken,
  recordStaking,
  updateStakingBalance,
  isProjectAddress,
  dispatchAlert,
  alertLargeRemoveLiquidity,
  getHolderBalance,
  publishRealtime,
  finalizeChainTransaction,
  enrichRealtimeTradePayload,
  maybeNotifyCatLiquidity,
  type EventType,
} from '@token-monitor/shared';
import { CHAIN_ID } from '../config.js';
import { fetchQuoteBalanceAfter } from './quoteBalanceAfter.js';
import {
  ENABLE_AU_STAKING_LISTENER,
  ENABLE_CAT_FARM_LISTENER,
  ENABLE_MASTER_CHEF_LISTENER,
} from '../chain/listenerConfig.js';
import { HOLDER_SKIP_BALANCEOF_ON_EVENT } from '../chain/listenerConfig.js';
import { applyIncrementalTransfer, resolveSwapHolderBalanceAfterTrade } from './holderIncremental.js';
import { markHolderForCalibration } from './holderCalibration.js';
import { getLpStakingConfig, recordLpStaking, syncWalletLpBalances, LP_EVENT_SYNC_BLOCK_RANGE } from './catLpStaking.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { tradePriceUsdFromEvent } from '../market/tradePrice.js';

export async function recordTransfer(
  provider: Provider,
  input: {
    tokenAddress: string;
    decimals: number;
    totalSupply: string;
    from: string;
    to: string;
    value: bigint;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    eventTime: number;
    pairAddress?: string;
  },
  opts?: { allowLpSync?: boolean },
): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  if (await shouldSkipChainEvent(token, input.txHash, input.logIndex)) {
    return false;
  }
  const pair = input.pairAddress?.toLowerCase();
  const fromL = input.from.toLowerCase();
  const toL = input.to.toLowerCase();
  const lpCfg = getLpStakingConfig(token);
  const lpPair = lpCfg?.pairAddress?.toLowerCase();
  const lpFarm = lpCfg?.stakingContract?.toLowerCase();

  /** Pair LP 代币 Transfer（listener 在 log.address === pair 时设置 pairAddress） */
  if (lpPair && pair === lpPair) {
    if (lpFarm && input.value > 0n) {
      if (toL === lpFarm) {
        await recordLpStaking({
          token_address: token,
          wallet_address: fromL,
          action: 'stake',
          amount: input.value.toString(),
          tx_hash: input.txHash,
          log_index: input.logIndex,
          block_number: input.blockNumber,
          event_time: input.eventTime,
        });
        void markHolderForCalibration(token, fromL);
      } else if (fromL === lpFarm) {
        await recordLpStaking({
          token_address: token,
          wallet_address: toL,
          action: 'unstake',
          amount: input.value.toString(),
          tx_hash: input.txHash,
          log_index: input.logIndex,
          block_number: input.blockNumber,
          event_time: input.eventTime,
        });
        void markHolderForCalibration(token, toL);
      }
    }
    const zero = '0x0000000000000000000000000000000000000000';
    if (opts?.allowLpSync === true) {
      for (const w of [fromL, toL]) {
        if (w && w !== lpPair && w !== lpFarm && w !== zero) {
          await syncWalletLpBalances(provider, token, w, {
            maxBlockRange: LP_EVENT_SYNC_BLOCK_RANGE,
          }).catch(() => {});
        }
      }
    }
    return true;
  }

  if (pair && (fromL === pair || toL === pair)) {
    await syncPairSideBalances(
      provider,
      token,
      input.from,
      input.to,
      input.decimals,
      input.totalSupply,
      pair,
    );
    return true;
  }

  await bumpTransferStat(token, fromL, toL, input.eventTime);

  const cfg = getMonitorToken(token);
  const staking =
    ENABLE_AU_STAKING_LISTENER ? cfg?.stakingContractAddress?.toLowerCase() : undefined;
  if (staking && input.value > 0n) {
    if (toL === staking) {
      await recordStaking({
        token_address: token,
        wallet_address: fromL,
        action: 'stake',
        amount: input.value.toString(),
        tx_hash: input.txHash,
        block_number: input.blockNumber,
        event_time: input.eventTime,
      });
      await insertEvent({
        token_address: token,
        event_type: 'stake',
        tx_hash: input.txHash,
        log_index: input.logIndex,
        block_number: input.blockNumber,
        event_time: input.eventTime,
        trader: fromL,
        token_amount: input.value.toString(),
      });
      await updateStakingBalance(token, fromL, input.value.toString());
    } else if (fromL === staking) {
      await recordStaking({
        token_address: token,
        wallet_address: toL,
        action: 'unstake',
        amount: input.value.toString(),
        tx_hash: input.txHash,
        block_number: input.blockNumber,
        event_time: input.eventTime,
      });
      await insertEvent({
        token_address: token,
        event_type: 'unstake',
        tx_hash: input.txHash,
        log_index: input.logIndex,
        block_number: input.blockNumber,
        event_time: input.eventTime,
        trader: toL,
        token_amount: input.value.toString(),
      });
      await updateStakingBalance(token, toL, '0');
    }
  }

  if (isProjectAddress(fromL) && input.value > 0n) {
    void dispatchAlert({
      alert_type: 'project_transfer',
      token_address: token,
      tx_hash: input.txHash,
      wallet_address: fromL,
      message: `📤 项目方地址转出 Token\n${fromL.slice(0, 10)}... · ${input.value.toString()}`,
    });
  }

  if (HOLDER_SKIP_BALANCEOF_ON_EVENT) {
    await applyIncrementalTransfer(
      token,
      fromL,
      toL,
      input.value,
      input.totalSupply,
      pair,
    );
  } else {
    await syncHolderBalance(provider, token, fromL, input.decimals, input.totalSupply, pair);
    await syncHolderBalance(provider, token, toL, input.decimals, input.totalSupply, pair);
  }

  const balanceAfter = await getHolderBalance(token, toL) ?? await getHolderBalance(token, fromL);
  const ok = await insertEvent({
    token_address: token,
    event_type: 'transfer',
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    event_time: input.eventTime,
    from_address: fromL,
    to_address: toL,
    trader: fromL,
    token_amount: input.value.toString(),
    balance_after: balanceAfter ?? undefined,
  });
  if (ok) {
    await finalizeChainTransaction(provider, {
      token_address: token,
      wallet_address: fromL,
      event_type: 'transfer',
      tx_hash: input.txHash,
      log_index: input.logIndex,
      block_number: input.blockNumber,
      block_time: input.eventTime,
      token_amount: input.value.toString(),
      balance_after: balanceAfter ?? undefined,
      from_address: fromL,
      to_address: toL,
      pair_address: pair,
      pushRealtime: false,
    });
  } else if (await eventExists(token, input.txHash, input.logIndex)) {
    return true;
  }
  return ok;
}

export async function recordSwap(
  provider: Provider,
  input: {
    tokenAddress: string;
    decimals: number;
    totalSupply: string;
    pairAddress: string;
    tradeType: 'buy' | 'sell';
    trader: string;
    tokenAmount: bigint;
    quoteAmount: bigint;
    price: number;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    eventTime: number;
  },
): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  if (await shouldSkipChainEvent(token, input.txHash, input.logIndex)) {
    return false;
  }
  const trader = input.trader.toLowerCase();
  const eventType: EventType = input.tradeType;
  const firstSwap = !await hasSwapEvent(token);

  const pairRow = await getPairByToken(token);
  const quoteToken = String(pairRow?.quote_token ?? '');
  const quoteMeta = quoteToken ? await fetchTokenMeta(provider, quoteToken) : null;
  const quoteDecimals = quoteMeta?.decimals ?? 18;
  const wbnbUsd = await fetchWbnbUsd(provider);
  const amountUsd = swapQuoteUsd(
    input.quoteAmount,
    quoteDecimals,
    quoteToken,
    wbnbUsd,
  );
  const contract = await getContract(token);
  const market = await getTokenMarket(token);

  if (HOLDER_SKIP_BALANCEOF_ON_EVENT) {
    await markHolderForCalibration(token, trader);
  } else {
    await syncHolderBalance(
      provider,
      token,
      trader,
      input.decimals,
      input.totalSupply,
      input.pairAddress,
    );
  }
  const balanceAfter = HOLDER_SKIP_BALANCEOF_ON_EVENT
    ? await resolveSwapHolderBalanceAfterTrade({
        tokenAddress: token,
        trader,
        tradeType: input.tradeType,
        tokenAmount: input.tokenAmount,
        txHash: input.txHash,
        pairAddress: input.pairAddress,
        totalSupply: input.totalSupply,
      })
    : ((await getHolderBalance(token, trader)) ?? '0');

  const quoteBalanceAfter = quoteToken
    ? await fetchQuoteBalanceAfter(provider, quoteToken, trader)
    : null;

  const ok = await insertEvent({
    token_address: token,
    event_type: eventType,
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    event_time: input.eventTime,
    trader,
    token_amount: input.tokenAmount.toString(),
    quote_amount: input.quoteAmount.toString(),
    price: input.price,
    pair_address: input.pairAddress,
    amount_usd: amountUsd,
    balance_after: balanceAfter ?? undefined,
    quote_balance_after: quoteBalanceAfter ?? undefined,
  });
  if (!ok) {
    return false;
  }

  const stat = await applyEventToStat(
    token,
    trader,
    eventType,
    input.tokenAmount,
    amountUsd,
    input.eventTime,
  );

  const tradePriceUsd = tradePriceUsdFromEvent(
    amountUsd,
    input.tokenAmount.toString(),
    input.decimals,
    input.price,
  );

  await finalizeChainTransaction(provider, {
    token_address: token,
    wallet_address: trader,
    event_type: eventType,
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    block_time: input.eventTime,
    token_amount: input.tokenAmount.toString(),
    quote_amount: input.quoteAmount.toString(),
    amount_usd: amountUsd,
    price: input.price,
    balance_after: balanceAfter ?? undefined,
    quote_balance_after: quoteBalanceAfter ?? undefined,
    pair_address: input.pairAddress,
    pushRealtime: true,
    stat,
    market,
    contract,
  });

  void publishRealtime({
    type: 'new_trade',
    tokenAddress: token,
    data: await enrichRealtimeTradePayload(
      token,
      trader,
      {
        txHash: input.txHash,
        walletAddress: trader,
        side: input.tradeType.toUpperCase(),
        tokenAmount: input.tokenAmount.toString(),
        quoteAmount: input.quoteAmount.toString(),
        amountUsd,
        price: input.price,
        blockNumber: input.blockNumber,
        blockTime: input.eventTime,
        balanceAfter: balanceAfter ?? '0',
        quoteBalanceAfter: quoteBalanceAfter ?? null,
      },
      { stat, contract },
    ),
  });

  await maybeAlertLargeTrade({
    tokenAddress: token,
    tradeType: input.tradeType,
    trader,
    amountUsd,
    tokenAmount: input.tokenAmount.toString(),
    decimals: input.decimals,
    price: input.price,
    txHash: input.txHash,
    pairAddress: input.pairAddress,
    symbol: contract?.token_symbol ?? undefined,
    buyCount: Number(stat?.buy_count ?? 0),
    sellCount: Number(stat?.sell_count ?? 0),
    holdingBalance: balanceAfter ?? '0',
    priceUsd: tradePriceUsd,
  });

  if (input.tradeType === 'sell') {
    const recentUnstake = await dbGet(
      `SELECT 1 AS ok FROM staking_record WHERE chain_id = ? AND token_address = ? AND wallet_address = ? AND action = 'unstake'
       AND event_time >= ? LIMIT 1`,
      [CHAIN_ID, token, trader, input.eventTime - 2 * 60 * 60_000],
    );
    if (recentUnstake) {
      void dispatchAlert({
        alert_type: 'unstake_then_sell',
        token_address: token,
        tx_hash: input.txHash,
        wallet_address: trader,
        amount_usd: amountUsd,
        level: 'HIGH',
        message: `⚠️ 解押后卖出\n$${amountUsd.toFixed(2)} · ${trader.slice(0, 10)}...`,
      });
    }
  }
  if (firstSwap) await updateContractStatus(token, 'trading_started');
  return true;
}

export async function recordLiquidityEvent(
  provider: Provider,
  input: {
    tokenAddress: string;
    eventType: 'add_liquidity' | 'remove_liquidity';
    txHash: string;
    logIndex: number;
    blockNumber: number;
    eventTime: number;
    pairAddress: string;
    trader: string;
    tokenAmount: string;
    quoteAmount?: string;
  },
): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  if (await shouldSkipChainEvent(token, input.txHash, input.logIndex)) {
    return false;
  }

  const ok = await insertEvent({
    token_address: token,
    event_type: input.eventType,
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    event_time: input.eventTime,
    trader: input.trader,
    token_amount: input.tokenAmount,
    quote_amount: input.quoteAmount ?? '0',
    pair_address: input.pairAddress,
  });
  if (!ok) {
    return false;
  }

  if (input.eventType === 'add_liquidity') {
    const tokenAmt = BigInt(input.tokenAmount || '0');
    const quoteAmt = BigInt(input.quoteAmount || '0');
    void maybeNotifyCatLiquidity(provider, {
      tokenAddress: input.tokenAddress,
      pairAddress: input.pairAddress,
      quoteToken: String((await getPairByToken(input.tokenAddress))?.quote_token ?? ''),
      tokenAmount: tokenAmt,
      quoteAmount: quoteAmt,
      txHash: input.txHash,
      blockNumber: input.blockNumber,
      eventTime: input.eventTime,
      notifyKey: 'first_add_liquidity',
      triggerLabel: '首次添加流动性',
    }).catch(() => undefined);
    void maybeNotifyCatLiquidity(provider, {
      tokenAddress: input.tokenAddress,
      pairAddress: input.pairAddress,
      quoteToken: String((await getPairByToken(input.tokenAddress))?.quote_token ?? ''),
      tokenAmount: tokenAmt,
      quoteAmount: quoteAmt,
      txHash: input.txHash,
      blockNumber: input.blockNumber,
      eventTime: input.eventTime,
      notifyKey: 'first_mint',
      triggerLabel: 'Pair Mint',
    }).catch(() => undefined);
  }

  if (input.eventType !== 'remove_liquidity') return true;

  const pairRow = await getPairByToken(input.tokenAddress);
  const quoteToken = String(pairRow?.quote_token ?? '');
  const quoteMeta = quoteToken ? await fetchTokenMeta(provider, quoteToken) : null;
  const wbnbUsd = await fetchWbnbUsd(provider);
  const amountUsd = swapQuoteUsd(
    BigInt(input.quoteAmount ?? '0'),
    quoteMeta?.decimals ?? 18,
    quoteToken,
    wbnbUsd,
  );
  await alertLargeRemoveLiquidity({
    tokenAddress: input.tokenAddress,
    pairAddress: input.pairAddress,
    trader: input.trader,
    amountUsd,
    txHash: input.txHash,
  });
  return true;
}

export async function recordStakingMasterEvent(input: {
  tokenAddress: string;
  eventName: string;
  user: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventTime: number;
  contractAddress: string;
}): Promise<boolean> {
  if (!ENABLE_MASTER_CHEF_LISTENER && !ENABLE_CAT_FARM_LISTENER) return true;
  const token = input.tokenAddress.toLowerCase();
  if (await shouldSkipChainEvent(token, input.txHash, input.logIndex)) {
    return false;
  }
  const user = input.user.toLowerCase();
  const name = input.eventName;
  let action: 'stake' | 'unstake' | 'reward' | null = null;
  if (name === 'Deposit' || name === 'Staked') action = 'stake';
  if (name === 'Withdraw' || name === 'Withdrawn' || name === 'EmergencyWithdraw') {
    action = 'unstake';
  }
  if (name === 'Harvest' || name === 'RewardPaid') action = 'reward';

  if (action === 'stake' || action === 'unstake') {
    await insertEvent({
      token_address: token,
      event_type: action,
      tx_hash: input.txHash,
      log_index: input.logIndex,
      block_number: input.blockNumber,
      event_time: input.eventTime,
      trader: user,
    });
    await markHolderForCalibration(token, user);
    return true;
  }
  if (action === 'reward') {
    await insertEvent({
      token_address: token,
      event_type: 'stake',
      tx_hash: input.txHash,
      log_index: input.logIndex,
      block_number: input.blockNumber,
      event_time: input.eventTime,
      trader: user,
    });
    return true;
  }
  return true;
}
