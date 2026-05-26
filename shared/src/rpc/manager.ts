import { JsonRpcProvider, WebSocketProvider } from 'ethers';
import { collectWssRpcUrls, TG_NOTIFY_RPC } from '../config.js';
import { getMeta, setMeta } from '../db/index.js';
import { listSyncStatus } from '../db/repos/syncStatusRepo.js';
import { SYNC_CONFIRM_BLOCKS } from '../chain/listenerConfig.js';
import { loadMonitorTokens } from '../monitorTokens.js';
import { publishRealtime } from '../realtime/publish.js';
import { insertAlert } from '../db/repos/alertRepo.js';
import {
  listConfiguredRpcUrls,
  RPC_DEFAULT_INDEX,
  RPC_FAILOVER_ENABLED,
  RPC_HEALTH_CHECK_INTERVAL_MS,
  RPC_MAX_CONSECUTIVE_FAILURES,
  RPC_MAX_GETLOGS_FAILURES,
  RPC_MAX_LATENCY_MS,
  RPC_RATE_LIMIT_COOLDOWN_MS,
  RPC_RATE_LIMIT_REMOVE_AFTER_STRIKES,
  RPC_REMOVE_RATE_LIMITED,
  RPC_TIMEOUT_MS,
} from './config.js';
import {
  isRateLimitError,
  maskRpcUrl,
  rpcNodeName,
  sanitizeRpcErrorMessage,
} from './mask.js';

export type RpcHealthStatus =
  | 'HEALTHY'
  | 'HIGH_LATENCY'
  | 'RATE_LIMITED'
  | 'UNAVAILABLE'
  | 'UNKNOWN';

export interface RpcNodeSnapshot {
  index: number;
  name: string;
  urlMasked: string;
  status: RpcHealthStatus;
  latencyMs: number | null;
  latestBlock: number | null;
  failCount: number;
  consecutiveFailures: number;
  lastError: string | null;
  checkedAt: number | null;
  isActive: boolean;
}

export interface RpcManagerPublicStatus {
  currentIndex: number;
  current: RpcNodeSnapshot;
  failoverEnabled: boolean;
  healthCheckIntervalMs: number;
  maxLatencyMs: number;
  timeoutMs: number;
  lastCheckAt: number;
  lastSyncedBlock: number | null;
  lagBlocks: number | null;
  syncByToken: {
    token_address: string;
    symbol: string;
    last_synced_block: number;
    lag_blocks: number;
  }[];
  nodes: RpcNodeSnapshot[];
}

/** @deprecated 兼容旧接口 */
export interface RpcStatus {
  current_rpc: string;
  latency: number;
  latest_block: number;
  status: string;
  checked_at: number;
}

type NodeInternal = {
  index: number;
  url: string;
  name: string;
  urlMasked: string;
  status: RpcHealthStatus;
  latencyMs: number | null;
  latestBlock: number | null;
  failCount: number;
  consecutiveFailures: number;
  lastError: string | null;
  checkedAt: number | null;
  rateLimitedUntil: number | null;
  rateLimitStrikes: number;
};

let nodes: NodeInternal[] = [];
let activeIndex = 0;
let httpProvider: JsonRpcProvider | null = null;
let wssProvider: WebSocketProvider | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let healthRunning = false;
let healthCheckInFlight: Promise<RpcManagerPublicStatus> | null = null;
let rpcReadyPromise: Promise<void> | null = null;
let lastCheckAt = 0;
let getLogsConsecutiveFailures = 0;
let lastFailoverAt = 0;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`RPC timeout after ${ms}ms`)), ms);
    }),
  ]);
}

async function probeUrl(url: string): Promise<{
  latencyMs: number;
  latestBlock: number;
}> {
  const p = new JsonRpcProvider(url, undefined, { staticNetwork: true });
  const start = Date.now();
  const latestBlock = await withTimeout(p.getBlockNumber(), RPC_TIMEOUT_MS);
  return { latencyMs: Date.now() - start, latestBlock };
}

function classifyProbe(
  err: unknown,
  latencyMs?: number,
): { status: RpcHealthStatus; lastError: string | null } {
  if (err) {
    if (isRateLimitError(err)) {
      return { status: 'RATE_LIMITED', lastError: sanitizeRpcErrorMessage(err) };
    }
    return { status: 'UNAVAILABLE', lastError: sanitizeRpcErrorMessage(err) };
  }
  if (latencyMs != null && latencyMs > RPC_MAX_LATENCY_MS) {
    return { status: 'HIGH_LATENCY', lastError: `latency ${latencyMs}ms > ${RPC_MAX_LATENCY_MS}ms` };
  }
  return { status: 'HEALTHY', lastError: null };
}

function snapshotNode(n: NodeInternal): RpcNodeSnapshot {
  return {
    index: n.index,
    name: n.name,
    urlMasked: n.urlMasked,
    status: n.status,
    latencyMs: n.latencyMs,
    latestBlock: n.latestBlock,
    failCount: n.failCount,
    consecutiveFailures: n.consecutiveFailures,
    lastError: n.lastError,
    checkedAt: n.checkedAt,
    isActive: n.index === activeIndex,
  };
}

function buildProvider(url: string): JsonRpcProvider {
  return new JsonRpcProvider(url, undefined, { staticNetwork: true });
}

function attachActiveProvider(index: number): void {
  const node = nodes[index];
  if (!node) throw new Error(`Invalid RPC index ${index}`);
  activeIndex = index;
  httpProvider = buildProvider(node.url);
  void setMeta('rpc_active_index', String(index));
  void setMeta('current_rpc', node.urlMasked);
}

function reindexNodes(): void {
  nodes.forEach((n, i) => {
    n.index = i;
    n.name = rpcNodeName(i, n.url);
  });
}

function isNodeInRateLimitCooldown(node: NodeInternal): boolean {
  return node.rateLimitedUntil != null && node.rateLimitedUntil > Date.now();
}

function markNodeRateLimited(node: NodeInternal, err: unknown, reason: string): void {
  node.status = 'RATE_LIMITED';
  node.lastError = sanitizeRpcErrorMessage(err);
  node.failCount++;
  node.consecutiveFailures++;
  node.rateLimitStrikes++;
  node.rateLimitedUntil = Date.now() + RPC_RATE_LIMIT_COOLDOWN_MS;

  const cooldownMin = Math.round(RPC_RATE_LIMIT_COOLDOWN_MS / 60_000);
  console.warn(
    `[RPC] ${node.name} 限流，冷却 ${cooldownMin} 分钟（${reason}，累计 ${node.rateLimitStrikes} 次）`,
  );

  if (
    RPC_REMOVE_RATE_LIMITED &&
    node.rateLimitStrikes >= RPC_RATE_LIMIT_REMOVE_AFTER_STRIKES &&
    node.index === activeIndex
  ) {
    try {
      removeRateLimitedNode(node.index, reason);
    } catch (e) {
      console.error('[RPC]', sanitizeRpcErrorMessage(e));
    }
  }
}

/** 从池中永久移除（仅 BSC_RPC_REMOVE_RATE_LIMITED=true 且多次限流时启用） */
function removeRateLimitedNode(index: number, reason: string): boolean {
  const node = nodes[index];
  if (!node || node.status !== 'RATE_LIMITED') return false;

  const removedName = node.name;
  const wasActive = index === activeIndex;
  nodes.splice(index, 1);
  reindexNodes();
  wssProvider = null;

  if (!nodes.length) {
    throw new Error(
      `所有 BSC RPC 节点均已被限流并移出池（最近: ${removedName}）。请在 .env 增加 BSC_RPC_URLS 后重启服务`,
    );
  }

  if (wasActive) {
    const next = pickBestHealthyIndex() ?? 0;
    attachActiveProvider(next);
    getLogsConsecutiveFailures = 0;
  } else if (activeIndex > index) {
    activeIndex--;
    void setMeta('rpc_active_index', String(activeIndex));
  }

  const msg = `[RPC] 已移除限流节点 ${removedName}（原因: ${reason}），剩余 ${nodes.length} 个`;
  console.warn(msg);
  void emitRpcAlert('rpc_node_removed', msg);
  return true;
}

function purgeRateLimitedNodes(reason: string): number {
  let removed = 0;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i]?.status !== 'RATE_LIMITED') continue;
    try {
      if (removeRateLimitedNode(i, reason)) removed++;
    } catch (e) {
      console.error('[RPC]', sanitizeRpcErrorMessage(e));
      break;
    }
  }
  return removed;
}

async function aggregateSync(): Promise<{
  lastSyncedBlock: number | null;
  lagBlocks: number | null;
  syncByToken: {
    token_address: string;
    symbol: string;
    last_synced_block: number;
    lag_blocks: number;
  }[];
}> {
  const symbolByToken = new Map(
    loadMonitorTokens().map((t) => [t.tokenAddress.toLowerCase(), t.symbol]),
  );
  const head = nodes[activeIndex]?.latestBlock ?? null;
  const safeHead =
    head != null ? Math.max(0, head - SYNC_CONFIRM_BLOCKS) : null;
  const allRows = await listSyncStatus();
  const fastRows = allRows.filter((r) => r.sync_type === 'fast_pair_listener');
  const slowByToken = new Map(
    allRows
      .filter((r) => r.sync_type === 'slow_transfer_listener')
      .map((r) => [String(r.token_address).toLowerCase(), Number(r.lag_blocks ?? 0)]),
  );
  const syncByToken = fastRows
    .filter((r) => symbolByToken.has(String(r.token_address).toLowerCase()))
    .map((r) => {
    const token = String(r.token_address).toLowerCase();
    const last = Number(r.last_synced_block ?? 0);
    const lag =
      safeHead != null
        ? Math.max(0, safeHead - last)
        : Number(r.lag_blocks ?? 0);
    return {
      token_address: token,
      symbol: symbolByToken.get(token) ?? token.slice(0, 8),
      last_synced_block: last,
      lag_blocks: lag,
      slow_lag_blocks: slowByToken.get(token) ?? 0,
      chain_head: safeHead,
    };
  });
  if (!syncByToken.length) {
    return { lastSyncedBlock: null, lagBlocks: null, syncByToken: [] };
  }
  const minSynced = Math.min(...syncByToken.map((t) => t.last_synced_block));
  const maxLag = Math.max(...syncByToken.map((t) => t.lag_blocks));
  return { lastSyncedBlock: minSynced, lagBlocks: maxLag, syncByToken };
}

async function emitRpcStatus(reason: string): Promise<void> {
  const status = await getRpcManagerStatus();
  await publishRealtime({
    type: 'rpc_status_update',
    data: { ...status, reason },
  });
}

async function emitRpcAlert(alertType: string, message: string): Promise<void> {
  if (!TG_NOTIFY_RPC) {
    console.warn(message);
    return;
  }
  const sendTelegram =
    process.env.ALERT_ASYNC !== 'false' && process.env.ALERT_ASYNC !== '0';
  await insertAlert({
    alert_type: alertType,
    level: alertType.includes('failover') ? 'HIGH' : 'MEDIUM',
    message,
    send_status: sendTelegram ? 'pending' : 'logged',
  });
  await publishRealtime({
    type: 'alert_event',
    data: { alert_type: alertType, message },
  });
}

function shouldFailoverActive(reason: string): boolean {
  if (!RPC_FAILOVER_ENABLED) return false;
  const active = nodes[activeIndex];
  if (!active) return false;
  if (Date.now() - lastFailoverAt < 5000) return false;
  if (reason === 'getlogs' && getLogsConsecutiveFailures >= RPC_MAX_GETLOGS_FAILURES) return true;
  if (isNodeInRateLimitCooldown(active)) return true;
  if (active.status === 'UNAVAILABLE') return true;
  if (active.consecutiveFailures >= RPC_MAX_CONSECUTIVE_FAILURES) return true;
  if (active.status === 'HIGH_LATENCY') return true;
  if (active.latestBlock == null && active.consecutiveFailures > 0) return true;
  return false;
}

function pickBestHealthyIndex(excludeIndex?: number): number | null {
  const candidates = nodes
    .filter((n) => n.index !== excludeIndex)
    .filter((n) => !isNodeInRateLimitCooldown(n))
    .filter((n) => n.status === 'HEALTHY')
    .filter((n) => n.latencyMs != null)
    .sort((a, b) => (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999));
  if (candidates.length) return candidates[0]!.index;
  const fallback = nodes
    .filter((n) => n.index !== excludeIndex)
    .filter((n) => !isNodeInRateLimitCooldown(n))
    .filter((n) => n.status === 'HIGH_LATENCY')
    .sort((a, b) => (a.latencyMs ?? 99999) - (b.latencyMs ?? 99999));
  return fallback[0]?.index ?? null;
}

export async function tryAutoFailover(reason: string): Promise<boolean> {
  if (!shouldFailoverActive(reason)) return false;
  const next = pickBestHealthyIndex(activeIndex);
  if (next == null || next === activeIndex) return false;
  const from = nodes[activeIndex]?.name ?? `RPC-${activeIndex}`;
  const to = nodes[next]?.name ?? `RPC-${next}`;
  attachActiveProvider(next);
  getLogsConsecutiveFailures = 0;
  lastFailoverAt = Date.now();
  const msg = `[RPC] 自动切换 ${from} → ${to}（原因: ${reason}）`;
  console.warn(msg);
  await emitRpcAlert('rpc_failover', msg);
  await emitRpcStatus('auto_failover');
  return true;
}

export function recordRpcGetLogsFailure(err: unknown): void {
  getLogsConsecutiveFailures++;
  const active = nodes[activeIndex];
  if (active && isRateLimitError(err)) {
    markNodeRateLimited(active, err, 'getlogs');
    void tryAutoFailover('getlogs');
    void emitRpcStatus('rate_limited_cooldown');
    return;
  }
  void tryAutoFailover('getlogs');
}

export function recordRpcGetLogsSuccess(): void {
  getLogsConsecutiveFailures = 0;
}

export function recordRpcCallFailure(err: unknown): void {
  const active = nodes[activeIndex];
  if (!active) return;
  active.failCount++;
  active.consecutiveFailures++;
  active.lastError = sanitizeRpcErrorMessage(err);
  if (isRateLimitError(err)) {
    markNodeRateLimited(active, err, 'call_failure');
    void tryAutoFailover('call_failure');
    void emitRpcStatus('rate_limited_cooldown');
    return;
  }
  if (active.status === 'HEALTHY') active.status = 'UNAVAILABLE';
  void tryAutoFailover('call_failure');
}

export function recordRpcCallSuccess(): void {
  getLogsConsecutiveFailures = 0;
}

function initNodes(urls: string[]): void {
  nodes = urls.map((url, index) => ({
    index,
    url,
    name: rpcNodeName(index, url),
    urlMasked: maskRpcUrl(url),
    status: 'UNKNOWN' as RpcHealthStatus,
    latencyMs: null,
    latestBlock: null,
    failCount: 0,
    consecutiveFailures: 0,
    lastError: null,
    checkedAt: null,
    rateLimitedUntil: null,
    rateLimitStrikes: 0,
  }));
}

async function runRpcHealthCheckAllBody(): Promise<RpcManagerPublicStatus> {
  if (!nodes.length) {
    const urls = listConfiguredRpcUrls();
    initNodes(urls);
  }

  await Promise.all(
    nodes.map(async (node) => {
      try {
        const { latencyMs, latestBlock } = await probeUrl(node.url);
        const { status, lastError } = classifyProbe(null, latencyMs);
        node.latencyMs = latencyMs;
        node.latestBlock = latestBlock;
        node.status = status;
        node.lastError = lastError;
        node.checkedAt = Date.now();
        node.consecutiveFailures = 0;
        node.rateLimitedUntil = null;
      } catch (err) {
        node.failCount++;
        node.consecutiveFailures++;
        const { status, lastError } = classifyProbe(err);
        node.status = status;
        node.lastError = lastError;
        node.latencyMs = null;
        node.latestBlock = null;
        node.checkedAt = Date.now();
        if (status === 'RATE_LIMITED') {
          node.rateLimitedUntil = Date.now() + RPC_RATE_LIMIT_COOLDOWN_MS;
          node.rateLimitStrikes++;
        }
      }
    }),
  );

  lastCheckAt = Date.now();

  if (RPC_REMOVE_RATE_LIMITED) {
    const removed = purgeRateLimitedNodes('health_check');
    if (removed > 0) await emitRpcStatus('rate_limited_removed');
  }

  const active = nodes[activeIndex];
  if (active && RPC_FAILOVER_ENABLED) {
    if (
      isNodeInRateLimitCooldown(active) ||
      active.status === 'UNAVAILABLE' ||
      active.consecutiveFailures >= RPC_MAX_CONSECUTIVE_FAILURES ||
      active.status === 'HIGH_LATENCY'
    ) {
      await tryAutoFailover('health_check');
    }
  }

  return await getRpcManagerStatus();
}

/** 全节点探测（单飞，避免并发请求堆叠阻塞 API） */
export async function runRpcHealthCheckAll(): Promise<RpcManagerPublicStatus> {
  if (healthCheckInFlight) return healthCheckInFlight;
  healthCheckInFlight = runRpcHealthCheckAllBody().finally(() => {
    healthCheckInFlight = null;
  });
  return healthCheckInFlight;
}

export async function getRpcManagerStatus(): Promise<RpcManagerPublicStatus> {
  const sync = await aggregateSync();
  const current = nodes[activeIndex];
  const currentSnap: RpcNodeSnapshot = current
    ? snapshotNode(current)
    : {
        index: 0,
        name: 'RPC-1',
        urlMasked: '—',
        status: 'UNKNOWN',
        latencyMs: null,
        latestBlock: null,
        failCount: 0,
        consecutiveFailures: 0,
        lastError: null,
        checkedAt: null,
        isActive: true,
      };

  return {
    currentIndex: activeIndex,
    current: currentSnap,
    failoverEnabled: RPC_FAILOVER_ENABLED,
    healthCheckIntervalMs: RPC_HEALTH_CHECK_INTERVAL_MS,
    maxLatencyMs: RPC_MAX_LATENCY_MS,
    timeoutMs: RPC_TIMEOUT_MS,
    lastCheckAt,
    lastSyncedBlock: sync.lastSyncedBlock,
    lagBlocks: sync.lagBlocks,
    syncByToken: sync.syncByToken,
    nodes: nodes.map(snapshotNode),
  };
}

export async function getRpcStatus(): Promise<RpcStatus> {
  const s = (await getRpcManagerStatus()).current;
  return {
    current_rpc: s.urlMasked,
    latency: s.latencyMs ?? -1,
    latest_block: s.latestBlock ?? 0,
    status: s.status.toLowerCase(),
    checked_at: s.checkedAt ?? 0,
  };
}

export async function ensureRpcManagerReady(): Promise<void> {
  if (nodes.length && httpProvider) return;
  if (rpcReadyPromise) return rpcReadyPromise;

  rpcReadyPromise = (async () => {
    const urls = listConfiguredRpcUrls();
    initNodes(urls);
    let idx = RPC_DEFAULT_INDEX;
    try {
      const metaIdx = await getMeta('rpc_active_index');
      if (metaIdx != null && metaIdx !== '') idx = Number(metaIdx);
    } catch (err) {
      console.warn(
        '[RPC] 读取 rpc_active_index 失败，使用默认节点:',
        err instanceof Error ? err.message : err,
      );
    }
    if (!Number.isFinite(idx) || idx < 0 || idx >= nodes.length) idx = RPC_DEFAULT_INDEX;
    attachActiveProvider(idx);
    const active = nodes[activeIndex];
    if (active) {
      try {
        const { latencyMs, latestBlock } = await probeUrl(active.url);
        active.latencyMs = latencyMs;
        active.latestBlock = latestBlock;
        const { status, lastError } = classifyProbe(null, latencyMs);
        active.status = status;
        active.lastError = lastError;
        active.checkedAt = Date.now();
        active.consecutiveFailures = 0;
        lastCheckAt = Date.now();
      } catch (err) {
        const { status, lastError } = classifyProbe(err);
        active.status = status;
        active.lastError = lastError;
        active.checkedAt = Date.now();
      }
    }
  })().finally(() => {
    rpcReadyPromise = null;
  });

  return rpcReadyPromise;
}

export async function pickBestHttpRpc(): Promise<string> {
  await ensureRpcManagerReady();
  if (RPC_FAILOVER_ENABLED) {
    const best = pickBestHealthyIndex();
    if (best != null && best !== activeIndex) attachActiveProvider(best);
  }
  return nodes[activeIndex]!.url;
}

export async function getHttpProvider(): Promise<JsonRpcProvider> {
  await ensureRpcManagerReady();
  const metaIdx = await getMeta('rpc_active_index');
  if (metaIdx != null && metaIdx !== '' && Number(metaIdx) !== activeIndex) {
    const idx = Number(metaIdx);
    if (idx >= 0 && idx < nodes.length) attachActiveProvider(idx);
  }
  return httpProvider!;
}

export async function refreshRpcStatus(): Promise<RpcStatus> {
  await ensureRpcManagerReady();
  if (Date.now() - lastCheckAt < 15_000) {
    return await getRpcStatus();
  }
  try {
    const start = Date.now();
    const block = await withTimeout(httpProvider!.getBlockNumber(), RPC_TIMEOUT_MS);
    const latency = Date.now() - start;
    const active = nodes[activeIndex];
    if (active) {
      active.latencyMs = latency;
      active.latestBlock = block;
      const { status, lastError } = classifyProbe(null, latency);
      active.status = status;
      active.lastError = lastError;
      active.checkedAt = Date.now();
      active.consecutiveFailures = 0;
    }
    recordRpcCallSuccess();
  } catch (err) {
    recordRpcCallFailure(err);
    await tryAutoFailover('refresh');
    if (!httpProvider) await ensureRpcManagerReady();
  }
  return await getRpcStatus();
}

export async function switchRpcByIndex(
  index: number,
  opts?: { allowHighLatency?: boolean },
): Promise<{ ok: true; warning?: string; status: RpcManagerPublicStatus }> {
  await ensureRpcManagerReady();
  if (index < 0 || index >= nodes.length) {
    throw new Error(`RPC index ${index} out of range (0-${nodes.length - 1})`);
  }

  await runRpcHealthCheckAll();
  const target = nodes[index]!;

  if (target.status === 'UNAVAILABLE' || target.status === 'UNKNOWN') {
    throw new Error(`目标 RPC 不可用（${target.name}）`);
  }
  if (target.status === 'RATE_LIMITED' || isNodeInRateLimitCooldown(target)) {
    throw new Error(`目标 RPC 被限流（${target.name}），请稍后再试`);
  }

  let warning: string | undefined;
  if (target.status === 'HIGH_LATENCY' && !opts?.allowHighLatency) {
    warning = `目标 RPC 延迟较高（${target.latencyMs}ms），已允许切换但可能影响同步速度`;
  }

  try {
    await probeUrl(target.url);
  } catch (err) {
    throw new Error(`目标 RPC 探测失败: ${sanitizeRpcErrorMessage(err)}`);
  }

  attachActiveProvider(index);
  getLogsConsecutiveFailures = 0;
  wssProvider = null;

  const msg = `[RPC] 手动切换至 ${target.name}（${target.urlMasked}）`;
  console.log(msg);
  await emitRpcAlert('rpc_manual_switch', msg);
  await emitRpcStatus('manual_switch');

  return { ok: true, warning, status: await getRpcManagerStatus() };
}

export function startRpcHealthCheckLoop(): void {
  if (healthTimer) return;

  setTimeout(() => {
    void ensureRpcManagerReady()
      .then(() => runRpcHealthCheckAll())
      .catch((err) => {
        console.error('[RPC] init:', sanitizeRpcErrorMessage(err));
      });
  }, 3000);

  healthTimer = setInterval(() => {
    if (healthRunning) return;
    healthRunning = true;
    void runRpcHealthCheckAll()
      .then(() => emitRpcStatus('health_check'))
      .catch((err) => {
        console.error('[RPC] health:', sanitizeRpcErrorMessage(err));
      })
      .finally(() => {
        healthRunning = false;
      });
  }, RPC_HEALTH_CHECK_INTERVAL_MS);
}

export function stopRpcHealthCheckLoop(): void {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
}

export async function getWssProvider(): Promise<WebSocketProvider> {
  if (wssProvider) return wssProvider;
  const urls = collectWssRpcUrls();
  for (const url of urls) {
    try {
      wssProvider = new WebSocketProvider(url);
      await wssProvider.getBlockNumber();
      return wssProvider;
    } catch {
      wssProvider = null;
    }
  }
  const http = await getHttpProvider();
  wssProvider = http as unknown as WebSocketProvider;
  return wssProvider;
}

export async function getCurrentRpcUrl(): Promise<string> {
  return nodes[activeIndex]?.urlMasked ?? (await getMeta('current_rpc')) ?? '';
}

/** @internal 仅本包测试 */
export function _getActiveRpcUrl(): string {
  return nodes[activeIndex]?.url ?? '';
}
