import { type Log, type Provider } from 'ethers';
import { getContract } from '../db/repos/contractRepo.js';
import { getPairByToken } from '../db/repos/pairRepo.js';
import {
  getSyncCursor,
  updateSyncProgress,
  ensureSyncStatus,
  markSyncFailed,
  markSyncRunning,
  alignSyncStartFloor,
  touchAllMonitorSyncHeartbeats,
  touchTokenSyncHeartbeats,
  type SyncType,
} from '../db/repos/syncStatusRepo.js';
import {
  recordSyncFailure,
  clearSyncFailure,
  listPendingRetries,
  abandonObsoleteSyncFailures,
} from '../db/repos/syncFailedRepo.js';
import { fetchTokenMeta } from '../token/erc20.js';
import { resolveQuoteToken, parseSwap, quoteSymbol } from '../swap/parse.js';
import { getMonitorToken, loadMonitorTokens } from '../monitorTokens.js';
import { fetchLogsBatched, groupLogsByAddress } from './batchedLogs.js';
import {
  LISTENER_SYNC_TYPES,
  ENABLE_MASTER_CHEF_LISTENER,
  ENABLE_TOKEN_TRANSFER_LISTENER,
  SYNC_CONFIRM_BLOCKS,
  SYNC_MAX_RETRIES,
  SYNC_RETRY_DELAY_MS,
  SYNC_BOOTSTRAP_MAX_CHUNKS_PER_TASK,
  LISTENER_MAX_SCANS_PER_POLL,
  SYNC_CATCHUP_LAG_BLOCKS,
  SYNC_CATCHUP_CHUNK_BLOCKS,
  SYNC_CATCHUP_MAX_SCANS_PER_POLL,
  SYNC_GETLOGS_MAX_BLOCK_RANGE,
  SYNC_TARGET_MAX_LAG_BLOCKS,
  FAST_PAIR_INTERVAL_ACTIVE,
  FAST_PAIR_INTERVAL_QUIET,
  MEDIUM_MC_INTERVAL_ACTIVE,
  MEDIUM_MC_INTERVAL_QUIET,
  SLOW_TRANSFER_INTERVAL_ACTIVE,
  SLOW_TRANSFER_INTERVAL_QUIET,
  type ListenerSyncType,
} from './listenerConfig.js';
import {
  FAST_PAIR_TOPICS,
  SLOW_TRANSFER_TOPICS,
  MEDIUM_MASTERCHEF_TOPICS,
  PAIR_IFACE,
  TRANSFER_IFACE,
  MC_IFACE,
  SWAP_TOPIC,
  SYNC_TOPIC,
  MINT_TOPIC,
  BURN_TOPIC,
  TRANSFER_TOPIC,
} from './listenerTopics.js';
import {
  isPairRecentlyActive,
  isStakingRecentlyActive,
  isTransferRecentlyActive,
  touchPairSwapActivity,
  touchStakingActivity,
  touchTransferActivity,
} from './listenerActivity.js';
import {
  ingestTransferLog,
  ingestSwapLog,
  ingestLiquidityLog,
  ingestSyncLog,
  ingestStakingLog,
  type IngestPairCtx,
} from './ingest.js';
import { notifyListenerSyncFailed } from './listenerHealth.js';
import { getLpStakingConfig } from '../services/catLpStaking.js';
import { rawEventExists } from '../db/repos/rawEventRepo.js';
import { PAIR_ABI } from '../abis.js';
import { Contract } from 'ethers';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function resolveBlockTimeMs(
  provider: Provider,
  blockNumber: number,
  cache: Map<number, number>,
): Promise<number> {
  const hit = cache.get(blockNumber);
  if (hit !== undefined) return hit;
  const block = await provider.getBlock(blockNumber);
  const ms = (block?.timestamp ?? 0) * 1000;
  cache.set(blockNumber, ms);
  return ms;
}

async function buildPairCtx(
  provider: Provider,
  tokenAddress: string,
  pairAddress: string,
  tokenDecimals: number,
): Promise<IngestPairCtx | null> {
  const pair = new Contract(pairAddress, PAIR_ABI, provider);
  const token0 = String(await pair.token0()).toLowerCase();
  const token1 = String(await pair.token1()).toLowerCase();
  const quote = resolveQuoteToken(token0, token1);
  if (!quote) return null;
  const quoteMeta = await fetchTokenMeta(provider, quote);
  const pairRow = await getPairByToken(tokenAddress);
  return {
    pairAddress: pairAddress.toLowerCase(),
    tokenAddress: tokenAddress.toLowerCase(),
    quoteToken: quote,
    quoteSymbol: String(pairRow?.quote_symbol ?? quoteSymbol(quote)),
    tokenIsToken0: token0 === tokenAddress.toLowerCase(),
    tokenDecimals,
    quoteDecimals: quoteMeta?.decimals ?? 18,
  };
}

type TokenCtx = {
  token: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  pairAddr: string;
  pairCtx: IngestPairCtx | null;
  stakingAddr: string;
};

type ChainHead = { latest: number; safeHead: number };

const TOKEN_CTX_TTL_MS = Math.max(
  10_000,
  Number(process.env.LISTENER_TOKEN_CTX_TTL_MS ?? 60_000),
);
const tokenCtxCache = new Map<string, { ctx: TokenCtx; expiresAt: number }>();

async function resolveChainHead(provider: Provider): Promise<ChainHead> {
  const latest = await provider.getBlockNumber();
  return { latest, safeHead: Math.max(0, latest - SYNC_CONFIRM_BLOCKS) };
}

async function loadTokenCtx(provider: Provider, tokenAddress: string): Promise<TokenCtx | null> {
  const token = tokenAddress.toLowerCase();
  const cached = tokenCtxCache.get(token);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.ctx;
  }
  const ctx = await loadTokenCtxUncached(provider, token);
  if (ctx) {
    tokenCtxCache.set(token, { ctx, expiresAt: Date.now() + TOKEN_CTX_TTL_MS });
  }
  return ctx;
}

async function loadTokenCtxUncached(provider: Provider, token: string): Promise<TokenCtx | null> {
  const cfg = getMonitorToken(token);
  if (!cfg) return null;
  const contract = await getContract(token);
  const pairRow = await getPairByToken(token);
  const pairAddr = (cfg.pairAddress || String(pairRow?.pair_address ?? '')).toLowerCase();
  let decimals = cfg.decimals ?? contract?.token_decimals ?? 18;
  let totalSupply = contract?.total_supply ?? '0';
  if (!contract?.total_supply) {
    const meta = await fetchTokenMeta(provider, token);
    if (meta) {
      decimals = meta.decimals;
      totalSupply = meta.totalSupply;
    }
  }
  const pairCtx = pairAddr ? await buildPairCtx(provider, token, pairAddr, decimals) : null;
  const lpFarm = getLpStakingConfig(token)?.stakingContract ?? '';
  const stakingAddr = lpFarm
    ? lpFarm
    : ENABLE_MASTER_CHEF_LISTENER && (cfg.stakingContractAddress ?? '').trim()
      ? (cfg.stakingContractAddress ?? '').toLowerCase()
      : '';
  return {
    token,
    symbol: cfg.symbol ?? token.slice(0, 8),
    decimals,
    totalSupply,
    pairAddr,
    pairCtx,
    stakingAddr,
  };
}

async function resolveStartFloor(token: string, cfgStart: number): Promise<number> {
  const contract = await getContract(token);
  const deployBlock = Number(contract?.block_number ?? 0);
  if (cfgStart > 0) return cfgStart;
  if (deployBlock > 0) return deployBlock;
  return 0;
}

async function ensureListenerSync(
  token: string,
  syncType: ListenerSyncType,
  startBlock: number,
  scanInterval: number,
): Promise<void> {
  await ensureSyncStatus({
    token_address: token,
    sync_type: syncType,
    start_block: startBlock,
    confirm_blocks: SYNC_CONFIRM_BLOCKS,
    scan_interval_blocks: scanInterval,
  });
  await alignSyncStartFloor(token, syncType, startBlock);
}

async function effectiveInterval(
  syncType: ListenerSyncType,
  token: string,
  pairAddr: string,
  stakingAddr: string,
): Promise<number> {
  if (syncType === LISTENER_SYNC_TYPES.FAST_PAIR) {
    if (!pairAddr) return FAST_PAIR_INTERVAL_ACTIVE;
    return (await isPairRecentlyActive(pairAddr))
      ? FAST_PAIR_INTERVAL_ACTIVE
      : FAST_PAIR_INTERVAL_QUIET;
  }
  if (syncType === LISTENER_SYNC_TYPES.MEDIUM_MASTERCHEF) {
    if (!stakingAddr) return MEDIUM_MC_INTERVAL_ACTIVE;
    return (await isStakingRecentlyActive(stakingAddr))
      ? MEDIUM_MC_INTERVAL_ACTIVE
      : MEDIUM_MC_INTERVAL_QUIET;
  }
  return (await isTransferRecentlyActive(token))
    ? SLOW_TRANSFER_INTERVAL_ACTIVE
    : SLOW_TRANSFER_INTERVAL_QUIET;
}

async function commitProgress(
  token: string,
  syncType: SyncType,
  chunkEnd: number,
  latest: number,
  safeHead: number,
  scanInterval: number,
): Promise<void> {
  const lagAfter = Math.max(0, safeHead - chunkEnd);
  await updateSyncProgress({
    token_address: token,
    sync_type: syncType,
    last_synced_block: chunkEnd,
    latest_block: latest,
    lag_blocks: lagAfter,
    scan_interval_blocks: scanInterval,
    status: lagAfter === 0 ? 'SYNCED' : 'RUNNING',
    error_message: null,
  });
}

async function processTransferLogs(
  provider: Provider,
  ctx: TokenCtx,
  logs: Log[],
  blockTimeCache: Map<number, number>,
): Promise<number> {
  let n = 0;
  const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const log of sorted) {
    const parsed = TRANSFER_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
    if (!parsed || parsed.name !== 'Transfer') continue;
    const from = String(parsed.args[0]).toLowerCase();
    const to = String(parsed.args[1]).toLowerCase();
    const value = BigInt(String(parsed.args[2]));
    const eventTime = await resolveBlockTimeMs(provider, log.blockNumber, blockTimeCache);
    const contractAddr = String(log.address).toLowerCase();
    const isLp = contractAddr === ctx.pairAddr;
    if (
      await ingestTransferLog(provider, {
        tokenAddress: ctx.token,
        decimals: ctx.decimals,
        totalSupply: ctx.totalSupply,
        from,
        to,
        value,
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
        eventTime,
        pairAddress: isLp ? ctx.pairAddr : undefined,
        topics: log.topics as string[],
        data: log.data,
      })
    ) {
      n++;
      void touchTransferActivity(ctx.token);
    }
  }
  return n;
}

async function processPairLogs(
  provider: Provider,
  ctx: TokenCtx,
  logs: Log[],
  blockTimeCache: Map<number, number>,
): Promise<number> {
  if (!ctx.pairCtx) return 0;
  let n = 0;
  const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const log of sorted) {
    const eventTime = await resolveBlockTimeMs(provider, log.blockNumber, blockTimeCache);
    const topic0 = log.topics[0];

    if (topic0 === SWAP_TOPIC) {
      const parsed = PAIR_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed || parsed.name !== 'Swap') continue;
      const trade = parseSwap(
        ctx.pairCtx,
        BigInt(String(parsed.args[1])),
        BigInt(String(parsed.args[2])),
        BigInt(String(parsed.args[3])),
        BigInt(String(parsed.args[4])),
      );
      if (!trade) continue;
      const tx = await provider.getTransaction(log.transactionHash);
      const trader = tx?.from?.toLowerCase() ?? String(parsed.args[5]).toLowerCase();
      if (
        await ingestSwapLog({
          tokenAddress: ctx.token,
          decimals: ctx.decimals,
          totalSupply: ctx.totalSupply,
          pairAddress: ctx.pairCtx.pairAddress,
          pairCtx: ctx.pairCtx,
          tradeType: trade.tradeType,
          trader,
          tokenAmount: trade.tokenAmount,
          quoteAmount: trade.quoteAmount,
          price: trade.price,
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          eventTime,
          topics: log.topics as string[],
          data: log.data,
        })
      ) {
        n++;
        await touchPairSwapActivity(ctx.pairAddr);
      }
    } else if (topic0 === SYNC_TOPIC) {
      const parsed = PAIR_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed || parsed.name !== 'Sync') continue;
      if (
        await ingestSyncLog({
          tokenAddress: ctx.token,
          pairAddress: ctx.pairCtx.pairAddress,
          pairCtx: ctx.pairCtx,
          reserve0: String(parsed.args[0]),
          reserve1: String(parsed.args[1]),
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          eventTime,
          topics: log.topics as string[],
          data: log.data,
        })
      ) {
        n++;
      }
    } else if (topic0 === MINT_TOPIC) {
      const parsed = PAIR_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed || parsed.name !== 'Mint') continue;
      const sender = String(parsed.args[0]).toLowerCase();
      const a0 = BigInt(String(parsed.args[1]));
      const a1 = BigInt(String(parsed.args[2]));
      if (
        await ingestLiquidityLog({
          tokenAddress: ctx.token,
          eventName: 'Mint',
          eventType: 'add_liquidity',
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          eventTime,
          pairAddress: ctx.pairCtx.pairAddress,
          trader: sender,
          tokenAmount: (ctx.pairCtx.tokenIsToken0 ? a0 : a1).toString(),
          quoteAmount: (ctx.pairCtx.tokenIsToken0 ? a1 : a0).toString(),
          topics: log.topics as string[],
          data: log.data,
        })
      ) {
        n++;
        await touchPairSwapActivity(ctx.pairAddr);
      }
    } else if (topic0 === BURN_TOPIC) {
      const parsed = PAIR_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed || parsed.name !== 'Burn') continue;
      const sender = String(parsed.args[0]).toLowerCase();
      const a0 = BigInt(String(parsed.args[1]));
      const a1 = BigInt(String(parsed.args[2]));
      if (
        await ingestLiquidityLog({
          tokenAddress: ctx.token,
          eventName: 'Burn',
          eventType: 'remove_liquidity',
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          eventTime,
          pairAddress: ctx.pairCtx.pairAddress,
          trader: sender,
          tokenAmount: (ctx.pairCtx.tokenIsToken0 ? a0 : a1).toString(),
          quoteAmount: (ctx.pairCtx.tokenIsToken0 ? a1 : a0).toString(),
          topics: log.topics as string[],
          data: log.data,
        })
      ) {
        n++;
        await touchPairSwapActivity(ctx.pairAddr);
      }
    } else if (topic0 === TRANSFER_TOPIC) {
      const parsed = TRANSFER_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      if (!parsed || parsed.name !== 'Transfer') continue;
      const from = String(parsed.args[0]).toLowerCase();
      const to = String(parsed.args[1]).toLowerCase();
      const value = BigInt(String(parsed.args[2]));
      if (
        await ingestTransferLog(provider, {
          tokenAddress: ctx.token,
          decimals: ctx.decimals,
          totalSupply: ctx.totalSupply,
          from,
          to,
          value,
          txHash: log.transactionHash,
          logIndex: log.index,
          blockNumber: log.blockNumber,
          eventTime,
          pairAddress: ctx.pairCtx.pairAddress,
          topics: log.topics as string[],
          data: log.data,
        })
      ) {
        n++;
        void touchTransferActivity(ctx.token);
      }
    }
  }
  return n;
}

async function processStakingLogs(
  ctx: TokenCtx,
  logs: Log[],
  blockTimeCache: Map<number, number>,
  provider: Provider,
): Promise<number> {
  let n = 0;
  const sorted = [...logs].sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  for (const log of sorted) {
    let parsed;
    try {
      parsed = MC_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
    } catch {
      continue;
    }
    if (!parsed) continue;
    const eventTime = await resolveBlockTimeMs(provider, log.blockNumber, blockTimeCache);
    const user = String(parsed.args[0] ?? parsed.args.user ?? '').toLowerCase();
    if (
      await ingestStakingLog({
        tokenAddress: ctx.token,
        contractAddress: ctx.stakingAddr,
        eventName: parsed.name,
        user,
        txHash: log.transactionHash,
        logIndex: log.index,
        blockNumber: log.blockNumber,
        eventTime,
        topics: log.topics as string[],
        data: log.data,
        args: parsed.args,
      })
    ) {
      n++;
      await touchStakingActivity(ctx.stakingAddr);
    }
  }
  return n;
}

type ScanPlan = {
  token: string;
  symbol: string;
  syncType: ListenerSyncType;
  fromBlock: number;
  toBlock: number;
  interval: number;
  ctx: TokenCtx;
};

function catchUpScanInterval(
  syncType: ListenerSyncType,
  blocksBehind: number,
  baseInterval: number,
): number {
  if (blocksBehind <= SYNC_TARGET_MAX_LAG_BLOCKS) {
    return Math.max(baseInterval, blocksBehind);
  }
  if (blocksBehind < SYNC_CATCHUP_LAG_BLOCKS) return baseInterval;
  const cap = Math.min(
    SYNC_GETLOGS_MAX_BLOCK_RANGE,
    syncType === LISTENER_SYNC_TYPES.SLOW_TRANSFER
      ? Math.max(SYNC_CATCHUP_CHUNK_BLOCKS, SLOW_TRANSFER_INTERVAL_ACTIVE)
      : SYNC_CATCHUP_CHUNK_BLOCKS,
  );
  return Math.max(baseInterval, Math.min(blocksBehind, cap));
}

async function buildScanPlans(
  provider: Provider,
  syncType: ListenerSyncType,
  head?: ChainHead,
): Promise<ScanPlan[]> {
  const { safeHead } = head ?? (await resolveChainHead(provider));
  const plans: ScanPlan[] = [];

  for (const cfg of loadMonitorTokens()) {
    const ctx = await loadTokenCtx(provider, cfg.tokenAddress);
    if (!ctx) continue;

    if (syncType === LISTENER_SYNC_TYPES.FAST_PAIR && !ctx.pairAddr) continue;
    if (syncType === LISTENER_SYNC_TYPES.MEDIUM_MASTERCHEF && !ctx.stakingAddr) continue;

    const startFloor = await resolveStartFloor(ctx.token, Number(cfg.startBlock ?? 0));
    const baseInterval = await effectiveInterval(
      syncType,
      ctx.token,
      ctx.pairAddr,
      ctx.stakingAddr,
    );
    await ensureListenerSync(ctx.token, syncType, startFloor, baseInterval);

    const cursor = await getSyncCursor(ctx.token, syncType);
    if (cursor.status === 'FAILED') {
      const pending = (await listPendingRetries(3)).filter(
        (r) => String(r.token_address) === ctx.token && String(r.sync_type) === syncType,
      );
      if (!pending.length) {
        await markSyncRunning({ token_address: ctx.token, sync_type: syncType });
      }
    }

    const fromBlock = Math.max(startFloor, cursor.lastSyncedBlock + 1);
    if (fromBlock > safeHead) continue;

    const blocksBehind = safeHead - cursor.lastSyncedBlock;
    const interval = catchUpScanInterval(syncType, blocksBehind, baseInterval);
    if (
      blocksBehind > 0 &&
      blocksBehind <= SYNC_TARGET_MAX_LAG_BLOCKS &&
      blocksBehind < baseInterval
    ) {
      continue;
    }

    const toBlock = Math.min(fromBlock + interval - 1, safeHead);
    plans.push({
      token: ctx.token,
      symbol: ctx.symbol,
      syncType,
      fromBlock,
      toBlock,
      interval,
      ctx,
    });
  }
  return plans;
}

async function assertRawIngestComplete(
  logs: Log[],
  ingestedNew: number,
): Promise<void> {
  if (!logs.length) return;
  const unique = new Map<string, Log>();
  for (const log of logs) {
    unique.set(`${log.transactionHash}:${log.index}`, log);
  }
  if (ingestedNew >= unique.size) return;
  for (const log of unique.values()) {
    const exists = await rawEventExists(log.transactionHash, log.index);
    if (!exists) {
      throw new Error(
        `raw_events ingest incomplete tx=${log.transactionHash} logIndex=${log.index}`,
      );
    }
  }
}

async function executeScan(
  provider: Provider,
  plan: ScanPlan,
): Promise<{ logs: number; ingested: number; allLogs: Log[] }> {
  const { fromBlock, toBlock, ctx, syncType } = plan;
  const blockTimeCache = new Map<number, number>();
  let logs = 0;
  let ingested = 0;
  const allLogs: Log[] = [];

  if (syncType === LISTENER_SYNC_TYPES.FAST_PAIR && ctx.pairAddr) {
    const pairLogs = await fetchLogsBatched(
      provider,
      [ctx.pairAddr],
      [FAST_PAIR_TOPICS],
      fromBlock,
      toBlock,
    );
    allLogs.push(...pairLogs);
    logs = pairLogs.length;
    ingested = await processPairLogs(provider, ctx, pairLogs, blockTimeCache);
  } else if (syncType === LISTENER_SYNC_TYPES.SLOW_TRANSFER) {
    const addresses = [ctx.token];
    if (ctx.pairAddr) addresses.push(ctx.pairAddr);
    const transferLogs = await fetchLogsBatched(
      provider,
      addresses,
      [SLOW_TRANSFER_TOPICS],
      fromBlock,
      toBlock,
    );
    allLogs.push(...transferLogs);
    logs = transferLogs.length;
    const byAddr = groupLogsByAddress(transferLogs);
    for (const addr of addresses) {
      ingested += await processTransferLogs(
        provider,
        ctx,
        byAddr.get(addr.toLowerCase()) ?? [],
        blockTimeCache,
      );
    }
  } else if (syncType === LISTENER_SYNC_TYPES.MEDIUM_MASTERCHEF && ctx.stakingAddr) {
    const mcLogs = await fetchLogsBatched(
      provider,
      [ctx.stakingAddr],
      [MEDIUM_MASTERCHEF_TOPICS],
      fromBlock,
      toBlock,
    );
    allLogs.push(...mcLogs);
    logs = mcLogs.length;
    ingested = await processStakingLogs(ctx, mcLogs, blockTimeCache, provider);
  }

  await assertRawIngestComplete(allLogs, ingested);
  return { logs, ingested, allLogs };
}

async function handleScanFailure(
  plan: ScanPlan,
  err: unknown,
  latest: number,
  safeHead: number,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const cursor = await getSyncCursor(plan.token, plan.syncType);
  const retries = await recordSyncFailure({
    token_address: plan.token,
    sync_type: plan.syncType,
    block_from: plan.fromBlock,
    block_to: plan.toBlock,
    error_message: msg,
  });
  const lag = Math.max(0, safeHead - cursor.lastSyncedBlock);
  console.error(
    `[${plan.syncType}] ${plan.symbol} blocks ${plan.fromBlock}-${plan.toBlock} failed (${retries}/${SYNC_MAX_RETRIES}): ${msg}`,
  );
  if (retries >= SYNC_MAX_RETRIES) {
    await markSyncFailed({
      token_address: plan.token,
      sync_type: plan.syncType,
      latest_block: latest,
      lag_blocks: lag,
      error_message: msg,
    });
    if (retries === SYNC_MAX_RETRIES) {
      await notifyListenerSyncFailed(plan.token, plan.fromBlock, plan.toBlock, msg);
    }
  } else {
    await updateSyncProgress({
      token_address: plan.token,
      sync_type: plan.syncType,
      latest_block: latest,
      lag_blocks: lag,
      status: 'RUNNING',
      error_message: msg,
    });
  }
}

async function runListenerTask(
  provider: Provider,
  syncType: ListenerSyncType,
  opts?: { maxScans?: number; label?: string },
): Promise<{ scans: number; idle: boolean }> {
  const maxScans = opts?.maxScans ?? LISTENER_MAX_SCANS_PER_POLL;
  const label = opts?.label ?? syncType;
  let scans = 0;

  while (scans < maxScans) {
    const head = await resolveChainHead(provider);
    const plans = await buildScanPlans(provider, syncType, head);
    if (!plans.length) break;

    const { latest, safeHead } = head;

    const batchKey = `${plans[0]!.fromBlock}-${plans[0]!.toBlock}`;
    const batch = plans.filter((p) => `${p.fromBlock}-${p.toBlock}` === batchKey);
    const fromBlock = batch[0]!.fromBlock;
    const toBlock = batch[0]!.toBlock;

    try {
      let totalLogs = 0;
      let totalIngested = 0;
      for (const plan of batch) {
        const r = await executeScan(provider, plan);
        totalLogs += r.logs;
        totalIngested += r.ingested;
        await commitProgress(
          plan.token,
          plan.syncType,
          toBlock,
          latest,
          safeHead,
          plan.interval,
        );
        await clearSyncFailure(plan.token, plan.syncType, fromBlock, toBlock);
      }
      if (totalLogs > 0 || process.env.SYNC_LOG_EMPTY_CHUNKS === 'true') {
        const symbols = batch.map((p) => p.symbol).join('+');
        console.log(
          `[${label}] ${symbols} blocks ${fromBlock}-${toBlock} logs=${totalLogs} ingested=${totalIngested}`,
        );
      }
      scans++;
      if (scans % 5 === 0) {
        for (const plan of batch) {
          await touchTokenSyncHeartbeats(plan.token);
        }
      }
    } catch (err) {
      for (const plan of batch) {
        await handleScanFailure(plan, err, latest, safeHead);
      }
      break;
    }
  }

  const remainingHead = await resolveChainHead(provider);
  const remaining = await buildScanPlans(provider, syncType, remainingHead);
  return { scans, idle: remaining.length === 0 };
}

export async function retryLayeredFailedChunks(provider: Provider): Promise<number> {
  for (const cfg of loadMonitorTokens()) {
    const token = cfg.tokenAddress.toLowerCase();
    for (const syncType of Object.values(LISTENER_SYNC_TYPES)) {
      const floor = await resolveStartFloor(token, Number(cfg.startBlock ?? 0));
      const cursor = await getSyncCursor(token, syncType);
      const minBlock = Math.max(floor, cursor.lastSyncedBlock + 1);
      await abandonObsoleteSyncFailures(token, syncType, minBlock);
    }
  }

  const pending = await listPendingRetries(20);
  let ok = 0;
  const head = await resolveChainHead(provider);
  for (const row of pending) {
    const syncType = String(row.sync_type) as ListenerSyncType;
    if (!Object.values(LISTENER_SYNC_TYPES).includes(syncType)) continue;

    const token = String(row.token_address);
    const from = Number(row.block_from);
    const to = Number(row.block_to);
    const ctx = await loadTokenCtx(provider, token);
    if (!ctx) {
      await clearSyncFailure(token, syncType, from, to);
      continue;
    }
    const interval = await effectiveInterval(syncType, token, ctx.pairAddr, ctx.stakingAddr);
    const plan: ScanPlan = {
      token,
      symbol: ctx.symbol,
      syncType,
      fromBlock: from,
      toBlock: to,
      interval,
      ctx,
    };
    const { latest, safeHead } = head;
    try {
      await executeScan(provider, plan);
      await clearSyncFailure(token, syncType, from, to);
      await commitProgress(token, syncType, to, latest, safeHead, interval);
      await markSyncRunning({ token_address: token, sync_type: syncType });
      ok++;
    } catch (err) {
      await handleScanFailure(plan, err, latest, safeHead);
    }
  }
  return ok;
}

export type LayeredRunResult = {
  fast: { scans: number; idle: boolean };
  medium: { scans: number; idle: boolean };
  slow: { scans: number; idle: boolean };
  allIdle: boolean;
};

export async function runAllLayeredListeners(
  provider: Provider,
  opts?: {
    maxScansPerTask?: number;
    slowMaxScansPerTask?: number;
    label?: string;
  },
): Promise<LayeredRunResult> {
  const maxScans = opts?.maxScansPerTask ?? LISTENER_MAX_SCANS_PER_POLL;
  const slowMax = opts?.slowMaxScansPerTask ?? maxScans;
  const label = opts?.label ?? 'Listener';

  await touchAllMonitorSyncHeartbeats();

  const fast = await runListenerTask(provider, LISTENER_SYNC_TYPES.FAST_PAIR, {
    maxScans,
    label: `${label}/fast`,
  });
  const medium = ENABLE_MASTER_CHEF_LISTENER
    ? await runListenerTask(provider, LISTENER_SYNC_TYPES.MEDIUM_MASTERCHEF, {
        maxScans,
        label: `${label}/mc`,
      })
    : { scans: 0, idle: true };
  const slow = ENABLE_TOKEN_TRANSFER_LISTENER
    ? await runListenerTask(provider, LISTENER_SYNC_TYPES.SLOW_TRANSFER, {
        maxScans: slowMax,
        label: `${label}/transfer`,
      })
    : { scans: 0, idle: true };
  await retryLayeredFailedChunks(provider);

  const allIdle = fast.idle && medium.idle && slow.idle;
  return { fast, medium, slow, allIdle };
}

export async function bootstrapLayeredListeners(provider: Provider): Promise<void> {
  for (const cfg of loadMonitorTokens()) {
    console.log(
      `[LayeredSync] bootstrap ${cfg.symbol} start=${cfg.startBlock ?? 0}`,
    );
  }
  let rounds = 0;
  const bootstrapMaxScans = Math.min(
    SYNC_CATCHUP_MAX_SCANS_PER_POLL,
    SYNC_BOOTSTRAP_MAX_CHUNKS_PER_TASK,
  );
  while (rounds < SYNC_BOOTSTRAP_MAX_CHUNKS_PER_TASK) {
    const r = await runAllLayeredListeners(provider, {
      maxScansPerTask: bootstrapMaxScans,
      label: 'Bootstrap',
    });
    rounds++;
    if (r.allIdle) break;
    await sleep(SYNC_RETRY_DELAY_MS);
  }
  for (const cfg of loadMonitorTokens()) {
    for (const st of Object.values(LISTENER_SYNC_TYPES)) {
      const c = await getSyncCursor(cfg.tokenAddress, st);
      console.log(
        `[LayeredSync] ${cfg.symbol} ${st} last=${c.lastSyncedBlock} interval=${c.scanIntervalBlocks} lag=${c.lagBlocks}`,
      );
    }
  }
}
