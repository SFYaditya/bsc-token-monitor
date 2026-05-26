#!/usr/bin/env node
/**
 * 检查 BSC 上某个地址（通常是合约）是否有链上活动（交易/代币转账/事件日志）。
 *
 * 说明：
 * - 如果提供 BSCSCAN_API_KEY（或 --bscscan-key），会通过 BscScan 查询历史普通交易/代币转账（更全面）
 * - 无 key 时会走 RPC 兜底：合约是否已部署、余额、nonce、以及最近 N 个区块该合约发出的事件日志
 *
 * 用法：
 *   node scripts/check-bsc-activity.mjs 0x... --blocks 5000
 *
 * 环境变量：
 *   BSC_RPC_URL         默认 https://bsc-dataseed.binance.org
 *   BSCSCAN_API_KEY     可选；提供后可查完整交易列表
 */

import { ethers } from 'ethers';

const DEFAULT_RPC = 'https://bsc-dataseed.binance.org';
const BSCSCAN_API = 'https://api.bscscan.com/api';

function getArg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  return process.argv[i + 1];
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function getIntArg(name, fallback) {
  const raw = getArg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function formatBNB(wei) {
  try {
    return `${ethers.formatEther(wei)} BNB`;
  } catch {
    return String(wei);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function bscscanCall(params) {
  const url = new URL(BSCSCAN_API);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`BscScan HTTP ${res.status}`);
  }
  const data = await res.json();
  return data;
}

function summarizeTxList(label, data) {
  if (!data) return { ok: false, msg: `${label}: no response` };
  const status = String(data.status ?? '');
  const message = String(data.message ?? '');
  const result = data.result;

  // BscScan 在“没有交易”时常见返回：status=0, message=No transactions found
  if (status === '0' && /no/i.test(message)) {
    return { ok: true, count: 0, msg: `${label}: 0` };
  }
  if (!Array.isArray(result)) {
    return { ok: false, msg: `${label}: unexpected result (${message || status})` };
  }
  return { ok: true, count: result.length, msg: `${label}: ${result.length}` };
}

async function checkWithBscScan({ address, apiKey }) {
  const base = {
    module: 'account',
    address,
    apikey: apiKey,
  };

  const [txlist, tokentx] = await Promise.all([
    bscscanCall({
      ...base,
      action: 'txlist',
      startblock: 0,
      endblock: 99999999,
      sort: 'asc',
    }),
    bscscanCall({
      ...base,
      action: 'tokentx',
      startblock: 0,
      endblock: 99999999,
      sort: 'asc',
    }),
  ]);

  return {
    txlist: summarizeTxList('普通交易(EOA/合约调用) txlist', txlist),
    tokentx: summarizeTxList('代币转账 tokentx', tokentx),
  };
}

async function tryGetLogsWindowed({ provider, address, fromBlock, toBlock }) {
  // 公共 RPC 经常限制 eth_getLogs 的窗口大小/频率，这里做“窗口分段 + 指数退避 + 自动缩窗”
  let cursor = fromBlock;
  let window = Math.max(200, Math.min(5000, toBlock - fromBlock + 1));
  let backoffMs = 300;
  let total = 0;
  let ok = true;
  let errors = 0;
  /** @type {Array<import('ethers').Log>} */
  const collected = [];

  while (cursor <= toBlock) {
    const end = Math.min(toBlock, cursor + window - 1);
    try {
      const logs = await provider.getLogs({ address, fromBlock: cursor, toBlock: end });
      total += logs.length;
      if (logs.length) collected.push(...logs);
      cursor = end + 1;
      backoffMs = 300;
      // 成功后逐步放大窗口（但不要太大）
      if (window < 8000) window = Math.floor(window * 1.3);
    } catch (e) {
      errors++;
      // 被限流/窗口太大时缩小窗口并退避重试
      window = Math.max(100, Math.floor(window / 2));
      backoffMs = Math.min(5000, Math.floor(backoffMs * 1.8));
      if (window === 100 && errors >= 8) {
        ok = false;
        return {
          ok,
          total,
          errors,
          msg: `getLogs 多次失败（已缩到最小窗口 100）：${e?.message ?? String(e)}`,
        };
      }
      await sleep(backoffMs);
    }
  }

  return { ok, total, errors, logs: collected };
}

async function checkWithRpc({ address, rpcUrl, blocks }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const [code, balance, nonce, latestBlock] = await Promise.all([
    provider.getCode(address),
    provider.getBalance(address),
    provider.getTransactionCount(address),
    provider.getBlockNumber(),
  ]);

  const isContract = code && code !== '0x';

  // 只统计该地址作为“日志产生者”的 logs（合约 emit 的事件）。这对“合约是否有活动”很有用。
  let logCount = 0;
  let fromBlock = Math.max(0, latestBlock - blocks + 1);
  if (blocks <= 0) {
    fromBlock = latestBlock;
  }

  if (isContract && blocks > 0) {
    try {
      const r = await tryGetLogsWindowed({
        provider,
        address,
        fromBlock,
        toBlock: latestBlock,
      });
      if (!r.ok) {
        return {
          rpcUrl,
          latestBlock,
          isContract,
          balance,
          nonce,
          logs: { ok: false, msg: r.msg ?? 'getLogs failed', partialCount: r.total },
        };
      }
      logCount = r.total;
      return {
        rpcUrl,
        latestBlock,
        isContract,
        balance,
        nonce,
        logs:
          blocks > 0 && isContract
            ? { ok: true, count: logCount, fromBlock, toBlock: latestBlock, items: r.logs ?? [] }
            : { ok: true, count: 0, fromBlock, toBlock: latestBlock, items: [] },
      };
    } catch (e) {
      // 某些 RPC 对 getLogs 可能有限制；失败时仍返回基础信息
      return {
        rpcUrl,
        latestBlock,
        isContract,
        balance,
        nonce,
        logs: { ok: false, msg: `getLogs 失败: ${e?.message ?? String(e)}` },
      };
    }
  }

  return {
    rpcUrl,
    latestBlock,
    isContract,
    balance,
    nonce,
    logs: blocks > 0 && isContract
      ? { ok: true, count: logCount, fromBlock, toBlock: latestBlock, items: [] }
      : { ok: true, count: 0, fromBlock, toBlock: latestBlock, items: [] },
  };
}

async function main() {
  const address = process.argv[2];
  if (!address || hasFlag('--help') || hasFlag('-h')) {
    console.log(
      [
        '用法: node scripts/check-bsc-activity.mjs <address> [--rpc <url>] [--blocks <n>] [--bscscan-key <key>]',
        '',
        '示例:',
        '  node scripts/check-bsc-activity.mjs 0x0385A003784430DAdD7a46089Ac705dc1b5fc4f8 --blocks 8000',
        '',
        '环境变量:',
        '  BSC_RPC_URL, BSCSCAN_API_KEY',
      ].join('\n'),
    );
    process.exit(address ? 0 : 1);
  }

  if (!ethers.isAddress(address)) {
    console.error(`地址不合法: ${address}`);
    process.exit(1);
  }

  const rpcUrl = getArg('--rpc') ?? process.env.BSC_RPC_URL ?? DEFAULT_RPC;
  const blocks = getIntArg('--blocks', Number(process.env.CHECK_BLOCKS ?? '5000'));
  const apiKey = getArg('--bscscan-key') ?? process.env.BSCSCAN_API_KEY;
  const showLogs = hasFlag('--show-logs');
  const maxLogs = getIntArg('--max-logs', 20);

  console.log(`目标地址: ${address}`);
  console.log(`RPC: ${rpcUrl}`);
  console.log(`扫描日志区块数(兜底): ${Number.isFinite(blocks) ? blocks : 'invalid'}`);
  console.log(`输出日志明细: ${showLogs ? '是' : '否'}${showLogs ? ` (max ${maxLogs})` : ''}`);
  console.log('');

  const rpcInfo = await checkWithRpc({
    address,
    rpcUrl,
    blocks: Number.isFinite(blocks) ? blocks : 0,
  });

  console.log('--- RPC 基础信息 ---');
  console.log(`latestBlock: ${rpcInfo.latestBlock}`);
  console.log(`是否合约: ${rpcInfo.isContract ? '是' : '否'}`);
  console.log(`余额: ${formatBNB(rpcInfo.balance)}`);
  console.log(`nonce(发起交易次数): ${rpcInfo.nonce}`);
  if (rpcInfo.logs?.ok) {
    console.log(
      `最近日志(合约 emit)数量: ${rpcInfo.logs.count} (from ${rpcInfo.logs.fromBlock} to ${rpcInfo.logs.toBlock})`,
    );
    if (showLogs && Array.isArray(rpcInfo.logs.items) && rpcInfo.logs.items.length) {
      const items = [...rpcInfo.logs.items].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
        return (a.index ?? 0) - (b.index ?? 0);
      });
      const sliced = items.slice(0, Math.max(0, maxLogs));
      console.log('');
      console.log(`--- 日志明细（前 ${sliced.length} 条）---`);
      for (const l of sliced) {
        const topic0 = Array.isArray(l.topics) && l.topics.length ? l.topics[0] : '0x';
        console.log(
          [
            `block=${l.blockNumber}`,
            `tx=${l.transactionHash}`,
            `logIndex=${l.index}`,
            `topic0=${topic0}`,
          ].join(' '),
        );
      }
      if (items.length > sliced.length) {
        console.log(`... 省略 ${items.length - sliced.length} 条（用 --max-logs 调大）`);
      }
    } else if (showLogs) {
      console.log('');
      console.log('--- 日志明细 ---');
      console.log('本次窗口内未拉到日志，或 RPC 未返回明细。');
    }
  } else {
    const extra =
      rpcInfo.logs && typeof rpcInfo.logs.partialCount === 'number'
        ? `（已累计到 ${rpcInfo.logs.partialCount} 条后失败）`
        : '';
    console.log(`最近日志(合约 emit)数量: 未知${extra}（${rpcInfo.logs?.msg ?? 'getLogs error'}）`);
  }

  console.log('');
  console.log('--- BscScan 历史查询 ---');
  // 很多情况下 BscScan 不带 key 也能用（但可能限流/返回受限），所以这里不强制要求 key
  try {
    const scan = await checkWithBscScan({ address, apiKey });
    console.log(scan.txlist.msg);
    console.log(scan.tokentx.msg);

    const any =
      (scan.txlist.ok && (scan.txlist.count ?? 0) > 0) ||
      (scan.tokentx.ok && (scan.tokentx.count ?? 0) > 0);
    console.log('');
    console.log(`结论(BscScan): ${any ? '该地址存在历史交易/转账活动' : '未查询到历史交易/转账活动'}`);
  } catch (e) {
    console.log(`BscScan 查询失败: ${e?.message ?? String(e)}`);
    console.log('提示: 配置 BSCSCAN_API_KEY 可提高稳定性/额度。');
  }

  if (apiKey) {
    console.log('');
    console.log('已检测到 BSCSCAN_API_KEY：查询更稳定。');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

