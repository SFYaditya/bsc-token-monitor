import { Contract, type Log, type Provider, zeroPadValue } from 'ethers';
import { pickBestHttpRpc, getHttpProvider } from '../rpc/manager.js';
import { ERC20_ABI } from '../abis.js';
import { dbAll, dbGet, dbRun, dbRunAffected } from '../db/pg/query.js';
import { CHAIN_ID } from '../config.js';
import { getMonitorToken } from '../monitorTokens.js';
import type { TokenConfig } from '../types.js';
import { getHolderProfile, upsertHolderProfile } from '../db/repos/holderProfileRepo.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { computeAddressGrading } from './whaleGrading.js';
import { computePnl } from './pnl.js';
import { lpValueUsdFromShare } from '../token/balanceMath.js';
import {
  clearSyncFailure,
  listPendingRetries,
  recordSyncFailure,
} from '../db/repos/syncFailedRepo.js';
import { fetchLogsBatched } from '../chain/batchedLogs.js';

const LP_STAKING_ABI = [
  'function userInfo(uint256 pid, address user) view returns (uint256 amount, uint256 rewardDebt)',
  'function balanceOf(address account) view returns (uint256)',
];

const LP_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export type LpStakingConfig = {
  tokenAddress: string;
  pairAddress: string;
  stakingContract: string;
  pid: number;
  fromBlock: number;
};

export function getLpStakingConfig(tokenAddress: string): LpStakingConfig | null {
  const cfg = getMonitorToken(tokenAddress);
  if (!cfg) return null;
  const staking = String(cfg.lpStakingContractAddress ?? '').trim().toLowerCase();
  const pair = String(cfg.pairAddress ?? '').trim().toLowerCase();
  if (!staking.startsWith('0x') || !pair.startsWith('0x')) return null;
  const fromBlock = Math.max(
    0,
    Number(cfg.lpStakingFromBlock ?? cfg.startBlock ?? 0),
  );
  return {
    tokenAddress: cfg.tokenAddress.toLowerCase(),
    pairAddress: pair,
    stakingContract: staking,
    pid: Math.max(0, Number(cfg.lpStakingPid ?? 0)),
    fromBlock,
  };
}

function addrTopic(address: string): string {
  return zeroPadValue(address.toLowerCase(), 32);
}

function topicToAddress(topic: string): string {
  const t = String(topic ?? '').toLowerCase();
  if (!t.startsWith('0x') || t.length < 42) return '';
  return `0x${t.slice(-40)}`;
}

const LP_STAKE_LOG_CHUNK = Math.max(
  1,
  Math.min(25, Number(process.env.LP_STAKE_LOG_CHUNK_BLOCKS ?? 25)),
);

/** 未显式指定 maxBlockRange 时的默认链上扫描窗口（块） */
export const LP_SYNC_DEFAULT_BLOCK_RANGE = Math.max(
  500,
  Number(process.env.LP_SYNC_DEFAULT_BLOCK_RANGE ?? 2000),
);

/** 事件热路径（Transfer/Stake）触发的 LP 校准窗口，默认与 LP_SYNC_DEFAULT_BLOCK_RANGE 一致 */
export const LP_EVENT_SYNC_BLOCK_RANGE = Math.max(
  500,
  Number(process.env.LP_EVENT_SYNC_BLOCK_RANGE ?? LP_SYNC_DEFAULT_BLOCK_RANGE),
);

async function fetchStakeTransferLogs(
  provider: Provider,
  pairAddress: string,
  topics: [string, string, string],
  fromBlock: number,
  toBlock: number,
  tokenAddress?: string,
): Promise<Log[]> {
  if (fromBlock > toBlock) return [];
  try {
    return await fetchLogsBatched(
      provider,
      [pairAddress],
      topics,
      fromBlock,
      toBlock,
      LP_STAKE_LOG_CHUNK,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[LpStaking] getLogs failed pair=${pairAddress} ${fromBlock}-${toBlock}: ${msg}`,
    );
    if (tokenAddress) {
      await recordSyncFailure({
        token_address: tokenAddress,
        sync_type: 'STAKING',
        block_from: fromBlock,
        block_to: toBlock,
        error_message: `lp_pair_logs: ${msg.slice(0, 500)}`,
      }).catch(() => undefined);
    }
    return [];
  }
}

/** 质押合约无 userInfo 时：按 LP 转入/转出质押合约净额计算 */
export async function readLpStakedViaPairTransfers(
  provider: Provider,
  config: LpStakingConfig,
  wallet: string,
  opts?: { maxBlockRange?: number },
): Promise<bigint> {
  const w = wallet.toLowerCase();
  const staking = config.stakingContract.toLowerCase();
  const toBlock = await provider.getBlockNumber();
  let fromBlock = Math.min(config.fromBlock, toBlock);
  const cap = opts?.maxBlockRange ?? LP_SYNC_DEFAULT_BLOCK_RANGE;
  if (cap > 0 && toBlock - fromBlock > cap) {
    fromBlock = toBlock - cap;
  }
  if (fromBlock > toBlock) return 0n;

  const userTopic = addrTopic(w);
  const stakingTopic = addrTopic(staking);

  const deposits = await fetchStakeTransferLogs(
    provider,
    config.pairAddress,
    [LP_TRANSFER_TOPIC, userTopic, stakingTopic],
    fromBlock,
    toBlock,
    config.tokenAddress,
  );
  const withdrawals = await fetchStakeTransferLogs(
    provider,
    config.pairAddress,
    [LP_TRANSFER_TOPIC, stakingTopic, userTopic],
    fromBlock,
    toBlock,
    config.tokenAddress,
  );

  let net = 0n;
  for (const log of deposits) net += BigInt(log.data);
  for (const log of withdrawals) net -= BigInt(log.data);
  return net > 0n ? net : 0n;
}

export type LpStakeTransferEvent = {
  action: 'stake' | 'unstake';
  amount: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
};

export async function fetchLpStakeTransferEvents(
  provider: Provider,
  config: LpStakingConfig,
  wallet: string,
): Promise<LpStakeTransferEvent[]> {
  const w = wallet.toLowerCase();
  const staking = config.stakingContract.toLowerCase();
  const userTopic = addrTopic(w);
  const stakingTopic = addrTopic(staking);
  const toBlock = await provider.getBlockNumber();
  const fromBlock = Math.min(config.fromBlock, toBlock);
  if (fromBlock > toBlock) return [];

  const deposits = await fetchStakeTransferLogs(
    provider,
    config.pairAddress,
    [LP_TRANSFER_TOPIC, userTopic, stakingTopic],
    fromBlock,
    toBlock,
    config.tokenAddress,
  );
  const withdrawals = await fetchStakeTransferLogs(
    provider,
    config.pairAddress,
    [LP_TRANSFER_TOPIC, stakingTopic, userTopic],
    fromBlock,
    toBlock,
    config.tokenAddress,
  );

  const events: LpStakeTransferEvent[] = [];
  for (const log of deposits) {
    events.push({
      action: 'stake',
      amount: BigInt(log.data).toString(),
      tx_hash: String(log.transactionHash ?? ''),
      log_index: Number(log.index ?? 0),
      block_number: Number(log.blockNumber ?? 0),
    });
  }
  for (const log of withdrawals) {
    events.push({
      action: 'unstake',
      amount: BigInt(log.data).toString(),
      tx_hash: String(log.transactionHash ?? ''),
      log_index: Number(log.index ?? 0),
      block_number: Number(log.blockNumber ?? 0),
    });
  }
  return events;
}

function isValidLpStakeTx(txHash: string, blockNumber?: number, eventTime?: number): boolean {
  const tx = txHash.toLowerCase();
  if (!/^0x[a-f0-9]{64}$/.test(tx)) return false;
  const body = tx.slice(2);
  if (/^0+$/.test(body) || /^0+1$/.test(body)) return false;
  const block = Number(blockNumber ?? 0);
  const time = Number(eventTime ?? 0);
  return block > 0 || time > 0;
}

export async function recordLpStaking(input: {
  token_address: string;
  wallet_address: string;
  action: 'stake' | 'unstake';
  amount: string;
  tx_hash: string;
  log_index: number;
  block_number?: number;
  event_time: number;
}): Promise<boolean> {
  if (BigInt(input.amount || '0') <= 0n) return false;
  if (!isValidLpStakeTx(input.tx_hash, input.block_number, input.event_time)) return false;
  try {
    const n = await dbRunAffected(
      `INSERT INTO lp_staking_record (
        chain_id, token_address, wallet_address, action, amount, tx_hash, log_index, block_number, event_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (chain_id, tx_hash, token_address, wallet_address, action) DO UPDATE SET
        amount = CASE
          WHEN CAST(EXCLUDED.amount AS NUMERIC) > CAST(lp_staking_record.amount AS NUMERIC)
          THEN EXCLUDED.amount
          ELSE lp_staking_record.amount
        END,
        log_index = EXCLUDED.log_index,
        block_number = COALESCE(EXCLUDED.block_number, lp_staking_record.block_number),
        event_time = GREATEST(lp_staking_record.event_time, EXCLUDED.event_time)`,
      [
        CHAIN_ID,
        input.token_address.toLowerCase(),
        input.wallet_address.toLowerCase(),
        input.action,
        input.amount,
        input.tx_hash.toLowerCase(),
        input.log_index,
        input.block_number ?? null,
        input.event_time,
      ],
    );
    return n > 0;
  } catch {
    return false;
  }
}

async function blockTimestampMs(
  provider: Provider,
  blockNumber: number,
  cache: Map<number, number>,
): Promise<number> {
  if (cache.has(blockNumber)) return cache.get(blockNumber)!;
  const block = await provider.getBlock(blockNumber);
  const t = Number(block?.timestamp ?? 0) * 1000;
  cache.set(blockNumber, t);
  return t;
}

export async function backfillLpStakingRecordsForWallet(
  provider: Provider,
  tokenAddress: string,
  wallet: string,
): Promise<number> {
  const config = getLpStakingConfig(tokenAddress);
  if (!config) return 0;
  const w = wallet.toLowerCase();
  const events = await fetchLpStakeTransferEvents(provider, config, w);
  if (!events.length) return 0;

  const blockCache = new Map<number, number>();
  let n = 0;
  for (const ev of events) {
    const eventTime = await blockTimestampMs(provider, ev.block_number, blockCache);
    const ok = await recordLpStaking({
      token_address: config.tokenAddress,
      wallet_address: w,
      action: ev.action,
      amount: ev.amount,
      tx_hash: ev.tx_hash,
      log_index: ev.log_index,
      block_number: ev.block_number,
      event_time: eventTime,
    });
    if (ok) n++;
  }
  return n;
}

export async function backfillMissingLpStakingRecords(
  tokenAddress: string,
  maxWallets = 8,
): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const config = getLpStakingConfig(token);
  if (!config) return 0;

  const missing = await dbAll<{ wallet_address: string }>(
    `SELECT hp.wallet_address FROM holder_profiles hp
     WHERE hp.chain_id = ? AND hp.token_address = ?
       AND CAST(hp.lp_staked_balance AS NUMERIC) > 0
       AND NOT EXISTS (
         SELECT 1 FROM lp_staking_record r
         WHERE r.chain_id = hp.chain_id AND r.token_address = hp.token_address
           AND r.wallet_address = hp.wallet_address AND r.action = 'stake'
       )
     LIMIT ?`,
    [CHAIN_ID, token, maxWallets],
  );
  if (!missing.length) return 0;

  await pickBestHttpRpc();
  const provider = await getHttpProvider();
  let total = 0;
  for (const row of missing) {
    try {
      total += await backfillLpStakingRecordsForWallet(
        provider,
        token,
        String(row.wallet_address),
      );
    } catch {
      /* skip wallet */
    }
  }
  return total;
}

export async function readLpWalletBalance(
  provider: Provider,
  pairAddress: string,
  wallet: string,
): Promise<bigint> {
  const c = new Contract(pairAddress, ERC20_ABI, provider);
  return (await c.balanceOf(wallet.toLowerCase())) as bigint;
}

export async function readPairTotalSupply(
  provider: Provider,
  pairAddress: string,
): Promise<bigint> {
  const c = new Contract(pairAddress, ERC20_ABI, provider);
  return (await c.totalSupply()) as bigint;
}

export async function readLpStakedBalance(
  provider: Provider,
  config: LpStakingConfig,
  wallet: string,
  opts?: { maxBlockRange?: number },
): Promise<bigint> {
  const w = wallet.toLowerCase();
  const c = new Contract(config.stakingContract, LP_STAKING_ABI, provider);
  try {
    const info = await c.userInfo(config.pid, w);
    const amount = info?.amount ?? info?.[0];
    const v = BigInt(amount ?? 0);
    if (v > 0n) return v;
  } catch {
    /* 非 MasterChef 或零质押时 revert */
  }
  try {
    const receiptBal = (await c.balanceOf(w)) as bigint;
    if (receiptBal > 0n) return receiptBal;
  } catch {
    /* 无质押凭证代币 */
  }
  return readLpStakedViaPairTransfers(provider, config, w, opts);
}

export async function readLpBalances(
  provider: Provider,
  config: LpStakingConfig,
  wallet: string,
  opts?: { maxBlockRange?: number },
): Promise<{ lpWallet: bigint; lpStaked: bigint }> {
  const [lpWallet, lpStaked] = await Promise.all([
    readLpWalletBalance(provider, config.pairAddress, wallet),
    readLpStakedBalance(provider, config, wallet, opts),
  ]);
  return { lpWallet, lpStaked };
}

export async function rebuildProfileLpFields(
  token: string,
  wallet: string,
  lpWallet: bigint,
  lpStaked: bigint,
): Promise<void> {
  const existing = await getHolderProfile(token, wallet);
  if (!existing) return;

  const contract = await getContract(token);
  const market = await getTokenMarket(token);
  const dec = contract?.token_decimals ?? 18;
  const priceUsd = market?.priceUsd ?? 0;
  const supply = contract?.total_supply ?? '0';

  const stat = await dbGet<Record<string, unknown>>(
    `SELECT * FROM token_address_stat WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, token, wallet],
  );

  const walletBalance = existing.wallet_balance ?? '0';
  const totalBalWei = BigInt(walletBalance) + BigInt(existing.staking_balance ?? '0');
  const pct =
    BigInt(supply) > 0n ? Number((totalBalWei * 10000n) / BigInt(supply)) / 100 : 0;

  const grading = await computeAddressGrading(
    token,
    wallet,
    priceUsd,
    market?.liquidityUsd ?? 0,
    dec,
  );

  const scale = 10 ** dec;
  const buyTok = BigInt(String(stat?.total_buy_token ?? '0'));
  const sellTok = BigInt(String(stat?.total_sell_token ?? '0'));
  const pnl = computePnl({
    balanceRaw: BigInt(walletBalance),
    totalBuyToken: buyTok,
    totalSellToken: sellTok,
    totalBuyUsd: Number(stat?.total_buy_value ?? 0),
    totalSellUsd: Number(stat?.total_sell_value ?? 0),
    priceUsd,
    tokenDecimals: dec,
  });

  await upsertHolderProfile({
    token_address: token,
    wallet_address: wallet,
    wallet_balance: walletBalance,
    staking_balance: existing.staking_balance,
    lp_balance: lpWallet.toString(),
    lp_staked_balance: lpStaked.toString(),
    balance_percent: pct,
    stat: stat ?? null,
    grading,
    pnl: {
      avgBuyPrice: buyTok > 0n ? Number(stat?.total_buy_value ?? 0) / (Number(buyTok) / scale) : 0,
      avgSellPrice: sellTok > 0n ? Number(stat?.total_sell_value ?? 0) / (Number(sellTok) / scale) : 0,
      ...pnl,
    },
    address_type: (existing as { address_type?: string }).address_type,
    is_contract: (existing as { is_contract?: number }).is_contract,
    price_usd: priceUsd,
    token_decimals: dec,
    last_balance_checked_at: (existing as { last_balance_checked_at?: number }).last_balance_checked_at,
    balance_source: (existing as { balance_source?: 'EVENT_ESTIMATED' | 'ONCHAIN_CONFIRMED' }).balance_source,
  });
}

/** 批量：按 lp_staking_record 汇总质押净额（与质押页一致的数据源） */
export async function sumLpStakedByWallets(
  tokenAddress: string,
  wallets: string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const uniq = [...new Set(wallets.map((w) => w.toLowerCase()).filter((w) => w.startsWith('0x')))];
  if (!uniq.length) return out;

  const token = tokenAddress.toLowerCase();
  const placeholders = uniq.map(() => '?').join(',');
  const rows = await dbAll<{ wallet_address: string; v: string }>(
    `SELECT wallet_address, COALESCE(SUM(signed), 0)::text AS v FROM (
       SELECT wallet_address,
              CASE WHEN action = 'stake' THEN CAST(amount AS NUMERIC)
                   WHEN action = 'unstake' THEN -CAST(amount AS NUMERIC)
                   ELSE 0 END AS signed
       FROM (
         SELECT DISTINCT ON (chain_id, tx_hash, token_address, wallet_address, action)
           wallet_address, action, amount
         FROM lp_staking_record
         WHERE chain_id = ? AND token_address = ? AND wallet_address IN (${placeholders})
         ORDER BY chain_id, tx_hash, token_address, wallet_address, action, log_index DESC
       ) deduped
     ) sums GROUP BY wallet_address`,
    [CHAIN_ID, token, ...uniq],
  );
  for (const r of rows) {
    const v = BigInt(r.v ?? '0');
    if (v > 0n) out.set(String(r.wallet_address).toLowerCase(), v);
  }
  return out;
}

export async function sumLpStakedFromRecords(token: string, wallet: string): Promise<bigint> {
  const row = await dbGet<{ v: string }>(
    `SELECT COALESCE(SUM(signed), 0)::text AS v FROM (
       SELECT CASE WHEN action = 'stake' THEN CAST(amount AS NUMERIC)
                   WHEN action = 'unstake' THEN -CAST(amount AS NUMERIC)
                   ELSE 0 END AS signed
       FROM (
         SELECT DISTINCT ON (chain_id, tx_hash, token_address, wallet_address, action)
           action, amount
         FROM lp_staking_record
         WHERE chain_id = ? AND token_address = ? AND wallet_address = ?
         ORDER BY chain_id, tx_hash, token_address, wallet_address, action, log_index DESC
       ) deduped
     ) sums`,
    [CHAIN_ID, token, wallet.toLowerCase()],
  );
  const net = BigInt(row?.v ?? '0');
  return net > 0n ? net : 0n;
}

/** 重试 STAKING 类型下 LP getLogs 失败块（验证 RPC 可读后清除失败记录） */
export async function retryLpStakingFailedChunks(
  provider: Provider,
  limit = 12,
): Promise<number> {
  const rows = await listPendingRetries(limit);
  let cleared = 0;
  for (const row of rows) {
    if (String(row.sync_type) !== 'STAKING') continue;
    if (!String(row.error_message ?? '').startsWith('lp_pair_logs')) continue;
    const config = getLpStakingConfig(String(row.token_address ?? ''));
    if (!config) continue;
    const from = Number(row.block_from);
    const to = Number(row.block_to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) continue;
    try {
      await fetchLogsBatched(
        provider,
        [config.pairAddress],
        [LP_TRANSFER_TOPIC],
        from,
        to,
        LP_STAKE_LOG_CHUNK,
      );
      await clearSyncFailure(config.tokenAddress, 'STAKING', from, to);
      cleared++;
    } catch {
      /* 仍失败，保留记录 */
    }
  }
  return cleared;
}

/** 删除无效流水（零块高/零时间、占位 tx_hash） */
export async function purgeInvalidLpStakingRecords(tokenAddress?: string): Promise<number> {
  const scope = tokenAddress ? ' AND token_address = ?' : '';
  const params = tokenAddress ? [tokenAddress.toLowerCase()] : [];
  return dbRunAffected(
    `DELETE FROM lp_staking_record
     WHERE (
       COALESCE(block_number, 0) = 0 AND COALESCE(event_time, 0) = 0
     ) OR tx_hash !~ '^0x[a-f0-9]{64}$'
       OR tx_hash ~ '^0x0+$'
       OR tx_hash ~ '^0x0+1$'
     ${scope}`,
    params,
  );
}

/** 将 holder_profiles.lp_staked_balance 与流水汇总对齐 */
export async function reconcileLpStakedProfilesFromRecords(
  tokenAddress: string,
): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const rows = await dbAll<{ wallet_address: string; v: string }>(
    `SELECT wallet_address, COALESCE(SUM(signed), 0)::text AS v FROM (
       SELECT wallet_address,
              CASE WHEN action = 'stake' THEN CAST(amount AS NUMERIC)
                   WHEN action = 'unstake' THEN -CAST(amount AS NUMERIC)
                   ELSE 0 END AS signed
       FROM (
         SELECT DISTINCT ON (chain_id, tx_hash, token_address, wallet_address, action)
           wallet_address, action, amount
         FROM lp_staking_record
         WHERE chain_id = ? AND token_address = ?
         ORDER BY chain_id, tx_hash, token_address, wallet_address, action, log_index DESC
       ) deduped
     ) sums GROUP BY wallet_address`,
    [CHAIN_ID, token],
  );
  let n = 0;
  for (const row of rows) {
    const w = String(row.wallet_address).toLowerCase();
    const staked = BigInt(row.v ?? '0');
    const hp = await getHolderProfile(token, w);
    if (!hp) continue;
    const prev = BigInt(hp.lp_staked_balance ?? '0');
    if (prev === staked) continue;
    await rebuildProfileLpFields(
      token,
      w,
      BigInt(hp.lp_balance ?? '0'),
      staked > 0n ? staked : 0n,
    );
    n++;
  }
  return n;
}

export function canonicalLpStakedRaw(
  wallet: string,
  profileRaw: string,
  recordSums: Map<string, bigint>,
): string {
  const fromRecords = recordSums.get(wallet.toLowerCase());
  if (fromRecords != null) return fromRecords.toString();
  return profileRaw || '0';
}

export async function dedupeLpStakingRecords(tokenAddress?: string): Promise<number> {
  const purged = await purgeInvalidLpStakingRecords(tokenAddress);
  const scope = tokenAddress ? ' AND a.token_address = ?' : '';
  const params = tokenAddress ? [tokenAddress.toLowerCase()] : [];
  const deduped = await dbRunAffected(
    `DELETE FROM lp_staking_record a USING lp_staking_record b
     WHERE a.id > b.id
       AND a.chain_id = b.chain_id
       AND a.token_address = b.token_address
       AND a.wallet_address = b.wallet_address
       AND a.action = b.action
       AND a.tx_hash = b.tx_hash
       ${scope}`,
    params,
  );
  return purged + deduped;
}

/** 质押量：库内流水汇总 → 近期链上 Transfer → 保留已有 profile（避免短窗口扫描写成 0） */
async function resolveLpStakedBalance(
  provider: Provider,
  config: LpStakingConfig,
  wallet: string,
  opts?: { maxBlockRange?: number },
): Promise<bigint> {
  const w = wallet.toLowerCase();
  const fromDb = await sumLpStakedFromRecords(config.tokenAddress, w);
  if (fromDb > 0n) return fromDb;

  const onchain = await readLpStakedBalance(provider, config, w, opts);
  if (onchain > 0n) return onchain;

  const hp = await getHolderProfile(config.tokenAddress, w);
  return BigInt(hp?.lp_staked_balance ?? '0');
}

export async function syncWalletLpBalances(
  provider: Provider,
  tokenAddress: string,
  wallet: string,
  opts?: { maxBlockRange?: number },
): Promise<void> {
  const config = getLpStakingConfig(tokenAddress);
  if (!config) return;
  const w = wallet.toLowerCase();
  const lpWallet = await readLpWalletBalance(provider, config.pairAddress, w);
  const lpStaked = await resolveLpStakedBalance(provider, config, w, opts);
  await rebuildProfileLpFields(config.tokenAddress, w, lpWallet, lpStaked);
}

/** 链上刷新监控地址与已有 LP 持仓用户的质押余额（不依赖慢速 Transfer 扫描滞后） */
export async function syncLpStakingWatchWallets(
  provider: Provider,
  tokenAddress: string,
): Promise<number> {
  const config = getLpStakingConfig(tokenAddress);
  if (!config) return 0;
  const token = tokenAddress.toLowerCase();
  const wallets = new Set<string>();
  for (const a of getMonitorToken(token)?.watchAddresses ?? []) {
    if (a) wallets.add(String(a).toLowerCase());
  }
  const rows = await dbAll<{ wallet_address: string }>(
    `SELECT wallet_address FROM holder_profiles
     WHERE chain_id = ? AND token_address = ?
       AND (CAST(lp_staked_balance AS NUMERIC) > 0 OR CAST(lp_balance AS NUMERIC) > 0)`,
    [CHAIN_ID, token],
  );
  for (const r of rows) wallets.add(String(r.wallet_address).toLowerCase());

  const quickScanBlocks = Math.max(
    8000,
    Number(process.env.LP_STAKE_QUICK_SCAN_BLOCKS ?? 20_000),
  );
  let n = 0;
  for (const w of wallets) {
    try {
      await syncWalletLpBalances(provider, token, w, {
        maxBlockRange: quickScanBlocks,
      });
      n++;
    } catch {
      /* skip */
    }
  }
  let totalLpSupply = '0';
  try {
    totalLpSupply = (await readPairTotalSupply(provider, config.pairAddress)).toString();
  } catch {
    /* skip */
  }
  await refreshTokenLpStakingStat(token, totalLpSupply);
  return n;
}

export async function calibrateTokenLpBalances(
  provider: Provider,
  tokenAddress: string,
): Promise<number> {
  const config = getLpStakingConfig(tokenAddress);
  if (!config) return 0;

  const wallets = new Set<string>();
  const top = await dbAll<{ wallet_address: string }>(
    `SELECT wallet_address FROM holder_profiles
     WHERE chain_id = ? AND token_address = ?
     ORDER BY balance_usd DESC NULLS LAST LIMIT 80`,
    [CHAIN_ID, config.tokenAddress],
  );
  for (const r of top) wallets.add(String(r.wallet_address).toLowerCase());

  const active = await dbAll<{ wallet_address: string }>(
    `SELECT wallet_address FROM token_address_stat
     WHERE chain_id = ? AND token_address = ? AND last_trade_time >= ?
     LIMIT 40`,
    [CHAIN_ID, config.tokenAddress, Date.now() - 24 * 60 * 60_000],
  );
  for (const r of active) wallets.add(String(r.wallet_address).toLowerCase());

  const cfg = getMonitorToken(config.tokenAddress);
  for (const a of cfg?.watchAddresses ?? []) {
    if (a) wallets.add(String(a).toLowerCase());
  }

  let n = 0;
  for (const w of wallets) {
    if (!w) continue;
    try {
      await syncWalletLpBalances(provider, config.tokenAddress, w, { maxBlockRange: 8000 });
      n++;
    } catch {
      /* skip single wallet */
    }
  }

  let totalLpSupply = 0n;
  try {
    totalLpSupply = await readPairTotalSupply(provider, config.pairAddress);
  } catch {
    /* skip */
  }
  await refreshTokenLpStakingStat(config.tokenAddress, totalLpSupply.toString());
  return n;
}

export async function refreshTokenLpStakingStat(
  tokenAddress: string,
  totalLpSupply = '0',
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const config = getLpStakingConfig(token);
  if (!config) return;

  const row = await dbGet<{ total_lp: string; stakers: number }>(
    `SELECT COALESCE(SUM(CAST(lp_staked_balance AS NUMERIC)), 0)::text AS total_lp,
            COUNT(*) FILTER (WHERE CAST(lp_staked_balance AS NUMERIC) > 0)::int AS stakers
     FROM holder_profiles
     WHERE chain_id = ? AND token_address = ?`,
    [CHAIN_ID, token],
  );

  const walletLp = await dbGet<{ v: string }>(
    `SELECT COALESCE(SUM(CAST(lp_balance AS NUMERIC)), 0)::text AS v
     FROM holder_profiles WHERE chain_id = ? AND token_address = ?`,
    [CHAIN_ID, token],
  );

  const now = Date.now();
  await dbRun(
    `INSERT INTO token_lp_staking_stat (
      chain_id, token_address, pair_address, staking_contract, staking_pid,
      total_lp_wallet, total_lp_staked, total_lp_supply, lp_staker_count, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (chain_id, token_address) DO UPDATE SET
      pair_address = EXCLUDED.pair_address,
      staking_contract = EXCLUDED.staking_contract,
      staking_pid = EXCLUDED.staking_pid,
      total_lp_wallet = EXCLUDED.total_lp_wallet,
      total_lp_staked = EXCLUDED.total_lp_staked,
      total_lp_supply = EXCLUDED.total_lp_supply,
      lp_staker_count = EXCLUDED.lp_staker_count,
      updated_at = EXCLUDED.updated_at`,
    [
      CHAIN_ID,
      token,
      config.pairAddress,
      config.stakingContract,
      config.pid,
      String(walletLp?.v ?? '0'),
      String(row?.total_lp ?? '0'),
      totalLpSupply,
      row?.stakers ?? 0,
      now,
    ],
  );
}

export function resolveLpUsdFields(
  lpBalanceRaw: string,
  lpStakedBalanceRaw: string,
  poolLiquidityUsd: number,
  totalLpSupplyRaw: string,
): { lpBalanceUsd: number; lpStakedBalanceUsd: number } {
  return {
    lpBalanceUsd: lpValueUsdFromShare(lpBalanceRaw, totalLpSupplyRaw, poolLiquidityUsd),
    lpStakedBalanceUsd: lpValueUsdFromShare(
      lpStakedBalanceRaw,
      totalLpSupplyRaw,
      poolLiquidityUsd,
    ),
  };
}

export async function reconcileLpStakingStatFromDb(tokenAddress: string): Promise<void> {
  const token = tokenAddress.toLowerCase();
  await dedupeLpStakingRecords(token);
  await reconcileLpStakedProfilesFromRecords(token);
  const existing = await getTokenLpStakingStat(token);
  await refreshTokenLpStakingStat(
    token,
    String(existing?.total_lp_supply ?? '0'),
  );
}

const LP_STAT_RECONCILE_MS = Math.max(
  15_000,
  Number(process.env.LP_STAKING_STAT_RECONCILE_MS ?? 120_000),
);
const lpStatReconcileLastAt = new Map<string, number>();

export async function listLpStakers(
  tokenAddress: string,
  opts: { page?: number; pageSize?: number; forceReconcile?: boolean } = {},
): Promise<{ items: Record<string, unknown>[]; total: number }> {
  const token = tokenAddress.toLowerCase();
  const page = opts.page ?? 1;
  const pageSize = Math.min(100, opts.pageSize ?? 50);
  const offset = (page - 1) * pageSize;

  const statRow = await getTokenLpStakingStat(token);
  const statAge = Date.now() - Number(statRow?.updated_at ?? 0);
  const lastReconcile = lpStatReconcileLastAt.get(token) ?? 0;
  if (
    opts.forceReconcile ||
    statAge > LP_STAT_RECONCILE_MS ||
    Date.now() - lastReconcile > LP_STAT_RECONCILE_MS
  ) {
    await reconcileLpStakingStatFromDb(token);
    lpStatReconcileLastAt.set(token, Date.now());
  }

  const market = await getTokenMarket(token);
  const lpStat = await getTokenLpStakingStat(token);
  const liquidityUsd = Number(market?.liquidityUsd ?? 0);
  const totalLpSupply = String(lpStat?.total_lp_supply ?? '0');

  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM holder_profiles
     WHERE chain_id = ? AND token_address = ? AND CAST(lp_staked_balance AS NUMERIC) > 0`,
    [CHAIN_ID, token],
  );
  const total = totalRow?.c ?? 0;

  const rows = await dbAll<Record<string, unknown>>(
    `SELECT wallet_address, lp_balance, lp_staked_balance, address_type, is_whale, is_super_whale
     FROM holder_profiles
     WHERE chain_id = ? AND token_address = ? AND CAST(lp_staked_balance AS NUMERIC) > 0
     ORDER BY LENGTH(lp_staked_balance) DESC, lp_staked_balance DESC
     LIMIT ? OFFSET ?`,
    [CHAIN_ID, token, pageSize, offset],
  );

  const wallets = rows.map((r) => String(r.wallet_address).toLowerCase());
  const recordStaked = await sumLpStakedByWallets(token, wallets);
  const statsByWallet = new Map<
    string,
    { stake_count: number; last_stake_time: number | null; last_stake_tx_hash: string | null }
  >();

  if (wallets.length) {
    const placeholders = wallets.map(() => '?').join(',');
    const agg = await dbAll<{
      wallet_address: string;
      stake_count: number;
      last_stake_time: number | null;
    }>(
      `SELECT wallet_address,
              COUNT(DISTINCT tx_hash) FILTER (
                WHERE action = 'stake'
                  AND COALESCE(block_number, 0) > 0
                  AND COALESCE(event_time, 0) > 0
              )::int AS stake_count,
              MAX(event_time) FILTER (WHERE action = 'stake') AS last_stake_time
       FROM lp_staking_record
       WHERE chain_id = ? AND token_address = ? AND wallet_address IN (${placeholders})
       GROUP BY wallet_address`,
      [CHAIN_ID, token, ...wallets],
    );
    for (const a of agg) {
      statsByWallet.set(String(a.wallet_address).toLowerCase(), {
        stake_count: a.stake_count ?? 0,
        last_stake_time: a.last_stake_time != null ? Number(a.last_stake_time) : null,
        last_stake_tx_hash: null,
      });
    }

    const lastTx = await dbAll<{ wallet_address: string; tx_hash: string }>(
      `SELECT DISTINCT ON (wallet_address) wallet_address, tx_hash
       FROM lp_staking_record
       WHERE chain_id = ? AND token_address = ? AND wallet_address IN (${placeholders})
         AND action = 'stake'
         AND COALESCE(block_number, 0) > 0
         AND COALESCE(event_time, 0) > 0
       ORDER BY wallet_address, event_time DESC`,
      [CHAIN_ID, token, ...wallets],
    );
    for (const t of lastTx) {
      const w = String(t.wallet_address).toLowerCase();
      const s = statsByWallet.get(w);
      if (s) s.last_stake_tx_hash = String(t.tx_hash);
      else {
        statsByWallet.set(w, {
          stake_count: 0,
          last_stake_time: null,
          last_stake_tx_hash: String(t.tx_hash),
        });
      }
    }
  }

  const items = rows.map((row) => {
    const w = String(row.wallet_address).toLowerCase();
    const lpStaked = canonicalLpStakedRaw(
      w,
      String(row.lp_staked_balance ?? '0'),
      recordStaked,
    );
    const lpBal = String(row.lp_balance ?? '0');
    const usd = resolveLpUsdFields(lpBal, lpStaked, liquidityUsd, totalLpSupply);
    const st = statsByWallet.get(w);
    return {
      wallet_address: row.wallet_address,
      lp_balance: lpBal,
      lp_staked_balance: lpStaked,
      lp_staked_balance_usd: usd.lpStakedBalanceUsd,
      lp_balance_usd: usd.lpBalanceUsd,
      address_type: row.address_type,
      is_whale: row.is_whale,
      is_super_whale: row.is_super_whale,
      stake_count: st?.stake_count ?? 0,
      last_stake_time: st?.last_stake_time ?? null,
      last_stake_tx_hash: st?.last_stake_tx_hash ?? null,
      record_type: 'lp_stake',
    };
  });

  return { items, total };
}

export async function getTokenLpStakingStat(
  tokenAddress: string,
): Promise<Record<string, unknown> | null> {
  const row = await dbGet<Record<string, unknown>>(
    `SELECT * FROM token_lp_staking_stat WHERE chain_id = ? AND token_address = ?`,
    [CHAIN_ID, tokenAddress.toLowerCase()],
  );
  return row ?? null;
}

/** 二分查找：LP 转入新质押合约的首个区块（用于合约迁移后缩小 rescan 范围） */
export async function findFirstLpDepositToStakingBlock(
  provider: Provider,
  config: LpStakingConfig,
  searchLo: number,
  searchHi: number,
): Promise<number | null> {
  const stakingTopic = addrTopic(config.stakingContract);
  let lo = Math.max(0, searchLo);
  let hi = Math.max(lo, searchHi);
  const probeSpan = Math.max(500, Number(process.env.LP_STAKE_FIND_FIRST_PROBE_BLOCKS ?? 4000));

  const hasDeposit = async (from: number, to: number): Promise<boolean> => {
    if (from > to) return false;
    try {
      const logs = await fetchLogsBatched(
        provider,
        [config.pairAddress],
        [LP_TRANSFER_TOPIC, null, stakingTopic],
        from,
        to,
        LP_STAKE_LOG_CHUNK,
      );
      return logs.length > 0;
    } catch {
      return false;
    }
  };

  if (!(await hasDeposit(lo, hi))) return null;

  let first = hi;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const to = Math.min(hi, mid + probeSpan - 1);
    if (await hasDeposit(mid, to)) {
      first = mid;
      hi = mid - 1;
    } else {
      lo = mid + probeSpan;
    }
  }
  return first;
}

async function ingestLpStakeLogs(
  provider: Provider,
  config: LpStakingConfig,
  logs: Log[],
  action: 'stake' | 'unstake',
  walletTopicIdx: number,
  wallets: Set<string>,
): Promise<number> {
  const blockCache = new Map<number, number>();
  let n = 0;
  const pair = config.pairAddress.toLowerCase();
  const farm = config.stakingContract.toLowerCase();

  for (const log of logs) {
    const wallet = topicToAddress(String(log.topics?.[walletTopicIdx] ?? ''));
    if (!wallet || wallet === pair || wallet === farm) continue;
    const amount = BigInt(log.data || '0');
    if (amount <= 0n) continue;
    const block_number = Number(log.blockNumber ?? 0);
    const eventTime = await blockTimestampMs(provider, block_number, blockCache);
    const ok = await recordLpStaking({
      token_address: config.tokenAddress,
      wallet_address: wallet,
      action,
      amount: amount.toString(),
      tx_hash: String(log.transactionHash ?? ''),
      log_index: Number(log.index ?? 0),
      block_number,
      event_time: eventTime,
    });
    if (ok) n++;
    wallets.add(wallet);
  }
  return n;
}

const LP_RESCAN_LOG_CHUNK = Math.max(
  LP_STAKE_LOG_CHUNK,
  Math.min(2000, Number(process.env.LP_STAKING_RESCAN_CHUNK_BLOCKS ?? 400)),
);

async function fetchLpTransfersInvolvingStaking(
  provider: Provider,
  config: LpStakingConfig,
  fromBlock: number,
  toBlock: number,
  direction: 'deposit' | 'withdraw',
  logChunk = LP_STAKE_LOG_CHUNK,
): Promise<Log[]> {
  if (fromBlock > toBlock) return [];
  const stakingTopic = addrTopic(config.stakingContract);
  const topics: (string | null)[] =
    direction === 'deposit'
      ? [LP_TRANSFER_TOPIC, null, stakingTopic]
      : [LP_TRANSFER_TOPIC, stakingTopic, null];
  return fetchLogsBatched(
    provider,
    [config.pairAddress],
    topics,
    fromBlock,
    toBlock,
    logChunk,
  );
}

export type RescanLpStakingResult = {
  tokenAddress: string;
  stakingContract: string;
  fromBlock: number;
  toBlock: number;
  recordsInserted: number;
  walletsDiscovered: number;
  walletsSynced: number;
  purgedRecords: number;
  profilesReset: number;
};

/**
 * 质押合约迁移后：清空旧流水、按 Pair→新质押合约 Transfer 重扫并刷新质押地址列表。
 */
export async function rescanLpStakingAddresses(
  provider: Provider,
  tokenAddress: string,
  opts?: {
    fromBlock?: number;
    toBlock?: number;
    purgeRecords?: boolean;
    autoDetectFromBlock?: boolean;
  },
): Promise<RescanLpStakingResult> {
  const config = getLpStakingConfig(tokenAddress);
  if (!config) {
    throw new Error('未配置 LP 质押合约');
  }

  const toBlock = opts?.toBlock ?? (await provider.getBlockNumber());
  let fromBlock = opts?.fromBlock ?? config.fromBlock;
  const searchLo = Math.max(0, Number(getMonitorToken(config.tokenAddress)?.startBlock ?? config.fromBlock));

  if (opts?.autoDetectFromBlock !== false && opts?.fromBlock == null) {
    const first = await findFirstLpDepositToStakingBlock(
      provider,
      config,
      searchLo,
      toBlock,
    );
    if (first != null) {
      fromBlock = first;
    } else {
      const window = Math.max(
        5000,
        Number(process.env.LP_STAKING_RESCAN_MAX_BLOCKS ?? 50_000),
      );
      fromBlock = Math.max(searchLo, toBlock - window);
      console.warn(
        `[LpStaking] rescan ${config.tokenAddress}: no LP deposit to ${config.stakingContract}, fallback last ${window} blocks`,
      );
    }
  }

  fromBlock = Math.min(fromBlock, toBlock);
  console.log(
    `[LpStaking] rescan ${config.tokenAddress} ${config.stakingContract} blocks ${fromBlock}-${toBlock}`,
  );

  let purgedRecords = 0;
  let profilesReset = 0;
  if (opts?.purgeRecords !== false) {
    purgedRecords = await dbRunAffected(
      `DELETE FROM lp_staking_record WHERE chain_id = ? AND token_address = ?`,
      [CHAIN_ID, config.tokenAddress],
    );
    profilesReset = await dbRunAffected(
      `UPDATE holder_profiles
       SET lp_staked_balance = '0', is_lp_staking_user = 0, updated_at = ?
       WHERE chain_id = ? AND token_address = ?
         AND (CAST(lp_staked_balance AS NUMERIC) > 0 OR is_lp_staking_user = 1)`,
      [Date.now(), CHAIN_ID, config.tokenAddress],
    );
  }

  const wallets = new Set<string>();
  let recordsInserted = 0;

  const deposits = await fetchLpTransfersInvolvingStaking(
    provider,
    config,
    fromBlock,
    toBlock,
    'deposit',
    LP_RESCAN_LOG_CHUNK,
  );
  recordsInserted += await ingestLpStakeLogs(
    provider,
    config,
    deposits,
    'stake',
    1,
    wallets,
  );

  const withdrawals = await fetchLpTransfersInvolvingStaking(
    provider,
    config,
    fromBlock,
    toBlock,
    'withdraw',
    LP_RESCAN_LOG_CHUNK,
  );
  recordsInserted += await ingestLpStakeLogs(
    provider,
    config,
    withdrawals,
    'unstake',
    2,
    wallets,
  );

  await dedupeLpStakingRecords(config.tokenAddress);
  await reconcileLpStakedProfilesFromRecords(config.tokenAddress);

  let walletsSynced = 0;
  for (const w of wallets) {
    try {
      await syncWalletLpBalances(provider, config.tokenAddress, w, {
        maxBlockRange: Math.max(0, toBlock - fromBlock + 1),
      });
      walletsSynced++;
    } catch {
      /* skip */
    }
  }

  let totalLpSupply = '0';
  try {
    totalLpSupply = (await readPairTotalSupply(provider, config.pairAddress)).toString();
  } catch {
    /* skip */
  }
  await refreshTokenLpStakingStat(config.tokenAddress, totalLpSupply);

  return {
    tokenAddress: config.tokenAddress,
    stakingContract: config.stakingContract,
    fromBlock,
    toBlock,
    recordsInserted,
    walletsDiscovered: wallets.size,
    walletsSynced,
    purgedRecords,
    profilesReset,
  };
}

export function lpMonitoringMeta(cfg: TokenConfig | undefined): Record<string, unknown> | null {
  const c = cfg ? getLpStakingConfig(cfg.tokenAddress) : null;
  if (!c) return null;
  return {
    enabled: true,
    pairAddress: c.pairAddress,
    stakingContract: c.stakingContract,
    stakingPid: c.pid,
  };
}
