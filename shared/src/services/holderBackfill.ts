import { Contract, Interface, ZeroAddress, type Provider } from 'ethers';
import { ERC20_ABI, RISK_SCAN_ABI } from '../abis.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getPairByToken } from '../db/repos/pairRepo.js';
import { syncMarketHolderCount } from '../db/repos/marketRepo.js';
import { countHolders } from '../db/repos/statRepo.js';
import { dbAll, dbRun } from '../db/pg/query.js';
import { calcBalancePercent } from '../token/balanceMath.js';
import { syncHolderBalance } from '../token/holderSync.js';
import { fetchBalance } from '../token/erc20.js';
import { loadProjectAddresses } from '../monitorTokens.js';
import { getMeta, setMeta } from '../db/index.js';
import { getMonitorToken } from '../monitorTokens.js';
import {
  recordRpcGetLogsFailure,
  recordRpcGetLogsSuccess,
} from '../rpc/manager.js';
import { isExcludedHolderAddress } from '../token/holderExclude.js';

async function recomputeHolderPercents(token: string, totalSupply: string): Promise<void> {
  const supply = BigInt(totalSupply || '0');
  if (supply <= 0n) return;
  const rows = await dbAll<{ holder_address: string; balance: string }>(
    `SELECT holder_address, balance FROM token_holder WHERE token_address = ? AND balance != '0'`,
    [token],
  );
  for (const r of rows) {
    const pct = calcBalancePercent(BigInt(r.balance || '0'), supply);
    await dbRun(
      `UPDATE token_holder SET balance_percent = ? WHERE token_address = ? AND holder_address = ?`,
      [pct, token, r.holder_address],
    );
  }
}

const TRANSFER_IFACE = new Interface(ERC20_ABI);
const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer')!.topicHash;
const ZERO = ZeroAddress.toLowerCase();
const DEFAULT_CHUNK = Number(process.env.HOLDER_BACKFILL_CHUNK ?? 4000);
const DEFAULT_LOOKBACK = Number(process.env.HOLDER_BACKFILL_LOOKBACK_BLOCKS ?? 500_000);

/** 无 Transfer 日志时仍尝试 owner 等静态地址（CAT 等仅 mint 给 owner 的代币） */
export async function discoverSeedHolderAddresses(
  provider: Provider,
  tokenAddress: string,
): Promise<string[]> {
  const token = tokenAddress.toLowerCase();
  const seeds = new Set<string>();
  const c = new Contract(token, RISK_SCAN_ABI, provider);
  for (const fn of ['owner', 'getOwner'] as const) {
    try {
      const addr = String(await c[fn]()).toLowerCase();
      if (addr.startsWith('0x') && addr.length === 42 && addr !== ZERO) {
        seeds.add(addr);
      }
    } catch {
      /* not Ownable */
    }
  }
  return [...seeds];
}

const BSCSCAN_HOLDER_PAGES = Number(process.env.BSCSCAN_HOLDER_PAGES ?? 3);

/** 无 Transfer 时从 BscScan 持仓页补充地址（如 CAT 构造函数 mint 未发事件） */
export async function fetchBscScanHolderAddresses(
  tokenAddress: string,
  maxPages = BSCSCAN_HOLDER_PAGES,
): Promise<string[]> {
  const token = tokenAddress.toLowerCase();
  const found = new Set<string>();
  const ua = 'Mozilla/5.0 (compatible; BscTokenMonitor/1.0)';
  for (let page = 1; page <= maxPages; page++) {
    const url = `https://bscscan.com/token/generic-tokenholders2?m=normal&a=${token}&s=0&p=${page}`;
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': ua, Accept: 'text/html' },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) break;
      const html = await res.text();
      const matches = html.match(/0x[a-fA-F0-9]{40}/g) ?? [];
      let pageHits = 0;
      for (const raw of matches) {
        const a = raw.toLowerCase();
        if (a === token || a === ZERO) continue;
        if (!found.has(a)) pageHits++;
        found.add(a);
      }
      if (pageHits === 0) break;
    } catch {
      break;
    }
  }
  return [...found];
}

/** 对指定地址做 balanceOf 并写入 token_holder（无 Pair / 无 Transfer 时仍可在持仓榜展示） */
export async function syncWatchListHolders(
  provider: Provider,
  tokenAddress: string,
  decimals: number,
  totalSupply: string,
  addresses: string[],
  pairAddress?: string,
): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const pair = pairAddress?.toLowerCase();
  const uniq = [
    ...new Set(
      addresses
        .map((a) => a.trim().toLowerCase())
        .filter((a) => a.startsWith('0x') && a.length === 42 && a !== ZERO),
    ),
  ];
  let withBalance = 0;
  const concurrency = 12;
  for (let i = 0; i < uniq.length; i += concurrency) {
    const batch = uniq.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (wallet) => {
        if (pair && wallet === pair) return;
        try {
          const bal = await fetchBalance(provider, token, wallet);
          if (bal <= 0n) return;
          await syncHolderBalance(provider, token, wallet, decimals, totalSupply, pair);
          withBalance++;
        } catch {
          /* skip bad address */
        }
      }),
    );
  }
  if (withBalance > 0) {
    await recomputeHolderPercents(token, totalSupply);
    await syncMarketHolderCount(token);
  }
  return withBalance;
}

export async function backfillTokenHolders(
  provider: Provider,
  tokenAddress: string,
  decimals: number,
  totalSupply: string,
  pairAddress?: string,
  opts?: { force?: boolean },
): Promise<{ addresses: number; synced: number; fromBlock: number; toBlock: number }> {
  const token = tokenAddress.toLowerCase();
  const metaKey = `holder_backfill:${token}`;
  const existingHolders = await countHolders(token);
  if (await getMeta(metaKey) === 'done' && existingHolders === 0) {
    await setMeta(metaKey, '');
  }
  if (!opts?.force && await getMeta(metaKey) === 'done' && existingHolders > 0) {
    return { addresses: 0, synced: existingHolders, fromBlock: 0, toBlock: 0 };
  }

  const pair =
    pairAddress?.toLowerCase() ??
    ((await getPairByToken(token))?.pair_address as string | undefined)?.toLowerCase();

  const contract = await getContract(token);
  const pairRow = await getPairByToken(token);
  const cfg = getMonitorToken(token);
  const latest = await provider.getBlockNumber();

  let fromBlock = cfg?.startBlock ?? 0;
  if (pairRow?.created_block != null) {
    fromBlock = Math.max(fromBlock, Number(pairRow.created_block));
  } else if (contract?.block_number != null) {
    fromBlock = Math.max(fromBlock, Number(contract.block_number));
  }
  if (!fromBlock || fromBlock <= 0) {
    fromBlock = Math.max(0, latest - DEFAULT_LOOKBACK);
  }

  const addresses = new Set<string>();
  const chunk = Math.max(500, DEFAULT_CHUNK);
  let transferLogHits = 0;

  const logChunk = Math.min(chunk, 2000);
  for (let start = fromBlock; start <= latest; start += logChunk + 1) {
    const end = Math.min(start + logChunk, latest);
    let logs: Awaited<ReturnType<typeof provider.getLogs>> = [];
    try {
      logs = await provider.getLogs({
        address: token,
        topics: [TRANSFER_TOPIC],
        fromBlock: start,
        toBlock: end,
      });
      recordRpcGetLogsSuccess();
    } catch (err) {
      recordRpcGetLogsFailure(err);
      await new Promise((r) => setTimeout(r, 400));
      continue;
    }
    for (const log of logs) {
      let parsed;
      try {
        parsed = TRANSFER_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
      } catch {
        continue;
      }
      if (!parsed || parsed.name !== 'Transfer') continue;
      const from = String(parsed.args[0]).toLowerCase();
      const to = String(parsed.args[1]).toLowerCase();
      if (from !== ZERO && from !== pair && !await isExcludedHolderAddress(token, from)) {
        addresses.add(from);
        transferLogHits++;
      }
      if (to !== ZERO && to !== pair && !await isExcludedHolderAddress(token, to)) {
        addresses.add(to);
        transferLogHits++;
      }
    }
  }

  for (const seed of await discoverSeedHolderAddresses(provider, token)) {
    addresses.add(seed);
  }

  if (transferLogHits === 0 || addresses.size === 0) {
    console.warn(
      `[HolderBackfill] ${token} Transfer 日志不足 (hits=${transferLogHits})，尝试 BscScan 持仓页补充`,
    );
    for (const a of await fetchBscScanHolderAddresses(token, 8)) {
      addresses.add(a);
    }
  }

  const list = [...addresses];
  const concurrency = 10;
  for (let i = 0; i < list.length; i += concurrency) {
    const batch = list.slice(i, i + concurrency);
    await Promise.all(
      batch.map((w) =>
        syncHolderBalance(provider, token, w, decimals, totalSupply, pair),
      ),
    );
  }

  const supply = contract?.total_supply ?? '0';
  await recomputeHolderPercents(token, supply);
  await syncMarketHolderCount(token);

  const watchExtra = [
    ...(cfg?.watchAddresses ?? []),
    ...(!cfg?.pairAddress?.trim() ? loadProjectAddresses() : []),
  ];
  let watchSynced = 0;
  if (watchExtra.length > 0) {
    watchSynced = await syncWatchListHolders(
      provider,
      token,
      decimals,
      supply,
      watchExtra,
      pair,
    );
  }

  if (list.length > 0 || watchSynced > 0 || await countHolders(token) > 0) {
    await setMeta(metaKey, 'done');
  }
  return {
    addresses: list.length + watchSynced,
    synced: await countHolders(token),
    fromBlock,
    toBlock: latest,
  };
}
