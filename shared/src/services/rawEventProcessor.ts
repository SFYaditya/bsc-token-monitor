import type { Provider } from 'ethers';
import { withPgTransaction } from '../db/pg/query.js';
import {
  listPendingRawEvents,
  markRawEventProcessed,
  countPendingRawEvents,
  type RawEventRow,
} from '../db/repos/rawEventRepo.js';
import { shouldSkipChainEvent, getRawEventStatus } from '../db/eventDedup.js';
import {
  recordTransfer,
  recordSwap,
  recordLiquidityEvent,
  recordStakingMasterEvent,
} from './chainEventHandlers.js';
import {
  getLpStakingConfig,
  recordLpStaking,
  refreshTokenLpStakingStat,
  syncWalletLpBalances,
  LP_EVENT_SYNC_BLOCK_RANGE,
} from './catLpStaking.js';
import { updateMarketFromSyncReserves } from './marketFromSync.js';
import { markHolderForCalibration } from './holderCalibration.js';
import type { IngestPairCtx } from '../chain/ingest.js';
import { insertPair, getPairByToken } from '../db/repos/pairRepo.js';
import { updateContractStatus } from '../db/repos/contractRepo.js';
import { notifyLpCreated } from '../telegram/notify.js';
import { resolveQuoteToken, quoteSymbol } from '../swap/parse.js';
import {
  ENABLE_CAT_FARM_LISTENER,
  ENABLE_MASTER_CHEF_LISTENER,
} from '../chain/listenerConfig.js';

export type RawEventBatchContext = {
  /** 批次开始时 pending 数量；仅当为 0 时在事件路径触发 LP 链上同步 */
  allowLpSync: boolean;
};

function parseDecoded(row: RawEventRow): Record<string, unknown> {
  try {
    return JSON.parse(String(row.decoded_data ?? '{}')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function processRawEvent(
  provider: Provider,
  row: RawEventRow,
  batch: RawEventBatchContext,
): Promise<'ok' | 'failed' | 'skipped'> {
  const data = parseDecoded(row);
  const token = String(row.token_address ?? '').toLowerCase();
  if (!token) {
    await markRawEventProcessed(row.tx_hash, row.log_index, 'failed', 'missing token');
    return 'failed';
  }

  const existing = await getRawEventStatus(row.tx_hash, row.log_index);
  if (existing === 'ok') return 'skipped';

  try {
    return await withPgTransaction(async () => {
      const status = await getRawEventStatus(row.tx_hash, row.log_index);
      if (status === 'ok') return 'skipped' as const;

      const result = await processRawEventBody(provider, row, token, data, batch);
      if (result === 'ok' || result === 'skipped') {
        await markRawEventProcessed(row.tx_hash, row.log_index, 'ok');
      }
      return result;
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markRawEventProcessed(row.tx_hash, row.log_index, 'failed', msg);
    return 'failed';
  }
}

async function processRawEventBody(
  provider: Provider,
  row: RawEventRow,
  token: string,
  data: Record<string, unknown>,
  batch: RawEventBatchContext,
): Promise<'ok' | 'skipped'> {
  if (row.event_name === 'Transfer') {
      const ok = await recordTransfer(
        provider,
        {
        tokenAddress: token,
        decimals: Number(data.decimals ?? 18),
        totalSupply: String(data.totalSupply ?? '0'),
        from: String(data.from ?? row.from_address ?? ''),
        to: String(data.to ?? row.to_address ?? ''),
        value: BigInt(String(data.value ?? '0')),
        txHash: row.tx_hash,
        logIndex: row.log_index,
        blockNumber: row.block_number,
        eventTime: row.block_time,
        pairAddress: data.pairAddress ? String(data.pairAddress) : undefined,
      },
        { allowLpSync: batch.allowLpSync },
      );
      if (!ok) {
        if (await shouldSkipChainEvent(token, row.tx_hash, row.log_index)) return 'skipped';
        throw new Error('transfer not applied');
      }
    } else if (row.event_name === 'Swap') {
      const ok = await recordSwap(provider, {
        tokenAddress: token,
        decimals: Number(data.decimals ?? 18),
        totalSupply: String(data.totalSupply ?? '0'),
        pairAddress: String(data.pairAddress ?? row.contract_address),
        tradeType: data.tradeType as 'buy' | 'sell',
        trader: String(data.trader ?? row.from_address ?? ''),
        tokenAmount: BigInt(String(data.tokenAmount ?? '0')),
        quoteAmount: BigInt(String(data.quoteAmount ?? '0')),
        price: Number(data.price ?? 0),
        txHash: row.tx_hash,
        logIndex: row.log_index,
        blockNumber: row.block_number,
        eventTime: row.block_time,
      });
      if (!ok) {
        if (await shouldSkipChainEvent(token, row.tx_hash, row.log_index)) return 'skipped';
        throw new Error('swap not applied');
      }
    } else if (row.event_name === 'Sync') {
      const pairCtx = data.pairCtx as IngestPairCtx | undefined;
      if (pairCtx) {
        await updateMarketFromSyncReserves(
          provider,
          {
            tokenAddress: token,
            pairCtx,
            reserve0: String(data.reserve0 ?? '0'),
            reserve1: String(data.reserve1 ?? '0'),
          },
        );
      }
      return 'ok';
    } else if (
      row.event_name === 'Deposit' ||
      row.event_name === 'Withdraw' ||
      row.event_name === 'EmergencyWithdraw' ||
      row.event_name === 'Harvest' ||
      row.event_name === 'Staked' ||
      row.event_name === 'Withdrawn' ||
      row.event_name === 'RewardPaid'
    ) {
      const lpCfg = getLpStakingConfig(token);
      const farm = lpCfg?.stakingContract ?? '';
      const contract = String(row.contract_address ?? '').toLowerCase();
      if (farm && contract === farm) {
        const user = String(data.user ?? row.from_address ?? '').toLowerCase();
        const args = data.args as Record<string, unknown> | unknown[] | undefined;
        const amountRaw =
          args && typeof args === 'object' && 'amount' in (args as object)
            ? String((args as { amount: unknown }).amount)
            : Array.isArray(args)
              ? String(args[2] ?? '0')
              : '0';
        if (row.event_name === 'Deposit' && BigInt(amountRaw || '0') > 0n) {
          await recordLpStaking({
            token_address: token,
            wallet_address: user,
            action: 'stake',
            amount: amountRaw,
            tx_hash: row.tx_hash,
            log_index: row.log_index,
            block_number: row.block_number ?? undefined,
            event_time: row.block_time,
          });
        } else if (
          row.event_name === 'Withdraw' ||
          row.event_name === 'EmergencyWithdraw' ||
          row.event_name === 'Withdrawn'
        ) {
          await recordLpStaking({
            token_address: token,
            wallet_address: user,
            action: 'unstake',
            amount: amountRaw || '0',
            tx_hash: row.tx_hash,
            log_index: row.log_index,
            block_number: row.block_number ?? undefined,
            event_time: row.block_time,
          });
        }
        if (batch.allowLpSync) {
          await syncWalletLpBalances(provider, token, user, {
            maxBlockRange: LP_EVENT_SYNC_BLOCK_RANGE,
          }).catch(
            () => {},
          );
        }
        await refreshTokenLpStakingStat(token);
        return 'ok';
      }
      if (!ENABLE_MASTER_CHEF_LISTENER && !ENABLE_CAT_FARM_LISTENER) return 'ok';
      const ok = await recordStakingMasterEvent({
        tokenAddress: token,
        eventName: row.event_name,
        user: String(data.user ?? row.from_address ?? ''),
        txHash: row.tx_hash,
        logIndex: row.log_index,
        blockNumber: row.block_number,
        eventTime: row.block_time,
        contractAddress: String(row.contract_address),
      });
      if (!ok) {
        if (await shouldSkipChainEvent(token, row.tx_hash, row.log_index)) return 'skipped';
        throw new Error('staking not applied');
      }
    } else if (row.event_name === 'PairCreated') {
      const token0 = String(data.token0 ?? '');
      const token1 = String(data.token1 ?? '');
      const pairAddr = String(data.pairAddress ?? '');
      if (!token0 || !token1 || !pairAddr) {
        throw new Error('PairCreated missing decoded fields');
      }
      if (await getPairByToken(token)) return 'skipped';
      const quote = resolveQuoteToken(token0, token1);
      if (!quote) return 'ok';
      await insertPair({
        token_address: token,
        pair_address: pairAddr,
        token0,
        token1,
        quote_token: quote,
        quote_symbol: quoteSymbol(quote),
        created_tx_hash: row.tx_hash,
        created_block: row.block_number,
      });
      await updateContractStatus(token, 'liquidity_created');
      await notifyLpCreated({
        tokenAddress: token,
        pairAddress: pairAddr,
        quoteSymbol: quoteSymbol(quote),
        txHash: row.tx_hash,
        eventTime: row.block_time,
      });
    } else if (row.event_name === 'Mint' || row.event_name === 'Burn') {
      const eventType =
        String(data.eventType ?? '') === 'remove_liquidity' || row.event_name === 'Burn'
          ? 'remove_liquidity'
          : 'add_liquidity';
      const ok = await recordLiquidityEvent(provider, {
        tokenAddress: token,
        eventType,
        txHash: row.tx_hash,
        logIndex: row.log_index,
        blockNumber: row.block_number,
        eventTime: row.block_time,
        pairAddress: String(row.contract_address),
        trader: String(data.trader ?? row.from_address ?? ''),
        tokenAmount: String(data.tokenAmount ?? '0'),
        quoteAmount: String(data.quoteAmount ?? '0'),
      });
      if (!ok) {
        if (await shouldSkipChainEvent(token, row.tx_hash, row.log_index)) return 'skipped';
        throw new Error('liquidity not applied');
      }
    } else {
      throw new Error(`unknown event ${row.event_name}`);
    }

  return 'ok';
}

const RAW_EVENT_CONCURRENCY = Math.max(
  1,
  Math.min(16, Number(process.env.RAW_EVENT_CONCURRENCY ?? 6)),
);

function walletsFromRawRow(row: RawEventRow, data: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const add = (a: unknown) => {
    const w = String(a ?? '').toLowerCase();
    if (w.startsWith('0x') && w.length === 42) out.add(w);
  };
  add(row.from_address);
  add(row.to_address);
  add(data.from);
  add(data.to);
  add(data.trader);
  add(data.user);
  return [...out];
}

export async function processPendingRawEvents(
  provider: Provider,
  limit = 200,
  opts?: { pendingBacklog?: number },
): Promise<{ processed: number; failed: number; fetched: number }> {
  const backlog = opts?.pendingBacklog ?? (await countPendingRawEvents());
  const batch: RawEventBatchContext = { allowLpSync: backlog === 0 };
  const rows = await listPendingRawEvents(limit);
  let processed = 0;
  let failed = 0;
  const calibrateWallets = new Map<string, Set<string>>();

  for (let i = 0; i < rows.length; i += RAW_EVENT_CONCURRENCY) {
    const chunk = rows.slice(i, i + RAW_EVENT_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (row) => {
        const data = parseDecoded(row);
        const r = await processRawEvent(provider, row, batch);
        if (r === 'ok') {
          const token = String(row.token_address ?? '').toLowerCase();
          if (token) {
            let set = calibrateWallets.get(token);
            if (!set) {
              set = new Set();
              calibrateWallets.set(token, set);
            }
            for (const w of walletsFromRawRow(row, data)) set.add(w);
          }
        }
        return r;
      }),
    );
    for (const r of results) {
      if (r === 'ok') processed++;
      else if (r === 'failed') failed++;
    }
  }

  for (const [token, wallets] of calibrateWallets) {
    for (const w of wallets) {
      void markHolderForCalibration(token, w);
    }
  }

  return { processed, failed, fetched: rows.length };
}
