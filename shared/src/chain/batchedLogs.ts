import type { Log, Provider } from 'ethers';
import { SYNC_GETLOGS_MAX_BLOCK_RANGE } from './listenerConfig.js';
import {
  acquireGetLogsSlot,
  noteGetLogsRateLimited,
  noteGetLogsSuccess,
} from './getLogsThrottle.js';
import {
  recordRpcGetLogsFailure,
  recordRpcGetLogsSuccess,
} from '../rpc/manager.js';

/** eth_getLogs 的 address 参数：单地址或地址数组 */
export function logFilterAddresses(addresses: string[]): string | string[] {
  const unique = [...new Set(addresses.map((a) => a.toLowerCase()).filter(Boolean))];
  if (unique.length === 0) throw new Error('getLogs: no addresses');
  return unique.length === 1 ? unique[0]! : unique;
}

export function groupLogsByAddress(logs: Log[]): Map<string, Log[]> {
  const map = new Map<string, Log[]>();
  for (const log of logs) {
    const addr = String(log.address).toLowerCase();
    const list = map.get(addr);
    if (list) list.push(log);
    else map.set(addr, [log]);
  }
  return map;
}

function parseMaxBlockRangeFromError(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = msg.match(/must not exceed\s+(\d+)\s+blocks?/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchLogsRange(
  provider: Provider,
  addresses: string[],
  topics: (string | string[] | null)[],
  fromBlock: number,
  toBlock: number,
): Promise<Log[]> {
  await acquireGetLogsSlot();
  try {
    const logs = await provider.getLogs({
      address: logFilterAddresses(addresses),
      topics,
      fromBlock,
      toBlock,
    });
    recordRpcGetLogsSuccess();
    noteGetLogsSuccess();
    return logs;
  } catch (err) {
    recordRpcGetLogsFailure(err);
    noteGetLogsRateLimited(err);
    throw err;
  }
}

/** 按 RPC 块跨度上限自动切分 eth_getLogs */
export async function fetchLogsBatched(
  provider: Provider,
  addresses: string[],
  topics: (string | string[] | null)[],
  fromBlock: number,
  toBlock: number,
  maxRange = SYNC_GETLOGS_MAX_BLOCK_RANGE,
): Promise<Log[]> {
  if (!addresses.length) return [];
  if (fromBlock > toBlock) return [];

  let range = Math.max(1, maxRange);
  const all: Log[] = [];
  let start = fromBlock;

  while (start <= toBlock) {
    const end = Math.min(start + range - 1, toBlock);
    try {
      all.push(...(await fetchLogsRange(provider, addresses, topics, start, end)));
      start = end + 1;
    } catch (err) {
      const limit = parseMaxBlockRangeFromError(err);
      if (limit != null && limit < range) {
        range = limit;
        continue;
      }
      if (end > start) {
        const mid = Math.floor((start + end) / 2);
        all.push(
          ...(await fetchLogsBatched(provider, addresses, topics, start, mid, range)),
          ...(await fetchLogsBatched(provider, addresses, topics, mid + 1, end, range)),
        );
        start = end + 1;
      } else {
        throw err;
      }
    }
  }
  return all;
}
