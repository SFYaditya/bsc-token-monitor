import {
  TG_NOTIFY_ENABLED,
  TG_NOTIFY_LISTENER,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
} from '../config.js';
import { insertAlert } from '../db/repos/alertRepo.js';
import { sendTelegramText } from '../telegram/notify.js';
import { alertDedupKey, shouldEmitAlert } from '../services/alertDedup.js';
import {
  touchListenerHeartbeat,
  getListenerService,
  maxTokenLagBlocks,
} from '../db/repos/listenerServiceRepo.js';
import { recordRpcCallFailure, recordRpcCallSuccess } from '../rpc/manager.js';
import {
  listStaleSyncHeartbeats,
  listHighLagSync,
  listSyncStatus,
} from '../db/repos/syncStatusRepo.js';
import { getMonitorToken, isMonitoredToken, loadMonitorTokens } from '../monitorTokens.js';
import {
  LISTENER_SERVICE_NAME,
  LISTENER_STALE_HEARTBEAT_MS,
  LISTENER_LAG_ALERT_BLOCKS,
} from './listenerConfig.js';

let consecutiveRpcFailures = 0;

export function recordRpcSuccess(): void {
  consecutiveRpcFailures = 0;
  recordRpcCallSuccess();
}

export function recordRpcFailure(err: unknown): void {
  consecutiveRpcFailures++;
  recordRpcCallFailure(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (consecutiveRpcFailures >= 3) {
    void notifyListenerIssue('listener_rpc_failed', `RPC 连续失败 ${consecutiveRpcFailures} 次: ${msg}`, {
      level: 'CRITICAL',
    });
  }
}

export async function notifyListenerIssue(
  alertType: string,
  message: string,
  opts?: {
    level?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    dedupSec?: number;
    tokenAddress?: string;
  },
): Promise<void> {
  const dedupSec = opts?.dedupSec ?? 600;
  const dedupToken = opts?.tokenAddress ?? 'global';
  const emit = await shouldEmitAlert(alertDedupKey(alertType, dedupToken), dedupSec);
  if (!emit) return;

  await insertAlert({
    alert_type: alertType,
    level: opts?.level ?? 'HIGH',
    message,
    send_status:
      TG_NOTIFY_ENABLED &&
      TG_NOTIFY_LISTENER &&
      TELEGRAM_BOT_TOKEN &&
      TELEGRAM_CHAT_ID
        ? 'pending'
        : 'logged',
  });

  if (
    TG_NOTIFY_ENABLED &&
    TG_NOTIFY_LISTENER &&
    TELEGRAM_BOT_TOKEN &&
    TELEGRAM_CHAT_ID
  ) {
    if (process.env.ALERT_ASYNC === 'false') {
      await sendTelegramText(message);
    }
  }
}

export async function notifyListenerSyncFailed(
  tokenAddress: string,
  fromBlock: number,
  toBlock: number,
  errorMessage: string,
): Promise<void> {
  const cfg = getMonitorToken(tokenAddress);
  const symbol = cfg?.symbol ?? tokenAddress.slice(0, 8);
  await notifyListenerIssue(
    'listener_sync_failed',
    `[ChainListener] ${symbol} 区块 ${fromBlock}-${toBlock} 同步失败（已标记 FAILED，未推进 last_synced_block）: ${errorMessage}`,
    { level: 'CRITICAL', dedupSec: 3600, tokenAddress: tokenAddress.toLowerCase() },
  );
}

export async function updateListenerHeartbeat(input: {
  latest_block?: number;
  status?: 'RUNNING' | 'DEGRADED' | 'FAILED';
  error_message?: string | null;
}): Promise<void> {
  const lag = await maxTokenLagBlocks();
  await touchListenerHeartbeat({
    service_name: LISTENER_SERVICE_NAME,
    status: input.status ?? (lag > LISTENER_LAG_ALERT_BLOCKS ? 'DEGRADED' : 'RUNNING'),
    latest_block: input.latest_block,
    lag_blocks: lag,
    error_message: input.error_message ?? null,
  });
}

export async function runListenerHealthCheck(): Promise<void> {
  const svc = await getListenerService(LISTENER_SERVICE_NAME);
  const hb = Number(svc?.heartbeat_at ?? 0);
  const staleMs = Date.now() - hb;
  if (hb > 0 && staleMs > LISTENER_STALE_HEARTBEAT_MS) {
    await notifyListenerIssue(
      'listener_stale',
      `[ChainListener] 心跳超时 ${Math.round(staleMs / 1000)}s（阈值 ${LISTENER_STALE_HEARTBEAT_MS / 1000}s）`,
      { level: 'CRITICAL' },
    );
  }

  const highLag = await listHighLagSync(LISTENER_LAG_ALERT_BLOCKS);
  for (const row of highLag) {
    const token = String(row.token_address);
    if (!isMonitoredToken(token)) continue;
    const cfg = getMonitorToken(token);
    const lag = Number(row.lag_blocks ?? 0);
    const last = Number(row.last_synced_block ?? 0);
    await notifyListenerIssue(
      'listener_lag',
      `[ChainListener] ${cfg?.symbol ?? token.slice(0, 8)} 落后 ${lag} 块（last_synced=${last}）`,
      { level: 'HIGH', dedupSec: 900, tokenAddress: token },
    );
  }

  const svcFresh =
    hb > 0 && Date.now() - hb <= LISTENER_STALE_HEARTBEAT_MS;
  const staleTokens = await listStaleSyncHeartbeats(LISTENER_STALE_HEARTBEAT_MS);
  const staleTokenAddrs = staleTokens
    .map((row) => String(row.token_address).toLowerCase())
    .filter((addr) => addr && isMonitoredToken(addr));
  if (staleTokenAddrs.length > 0 && !svcFresh) {
    const symbols = staleTokenAddrs
      .map((token) => getMonitorToken(token)?.symbol ?? token.slice(0, 8))
      .sort();
    const staleSec = Math.round(LISTENER_STALE_HEARTBEAT_MS / 1000);
    await notifyListenerIssue(
      'listener_token_stale',
      `[ChainListener] Token ${symbols.join('、')} 同步心跳超时（>${staleSec}s 无活跃 listener 进度，服务可能卡住）`,
      { level: 'HIGH', dedupSec: 1800, tokenAddress: 'batch' },
    );
  }

  for (const row of await listSyncStatus()) {
    const token = String(row.token_address);
    if (!isMonitoredToken(token)) continue;
    if (row.status === 'FAILED') {
      const cfg = getMonitorToken(token);
      await notifyListenerIssue(
        'listener_sync_failed',
        `[ChainListener] ${cfg?.symbol ?? token.slice(0, 8)} 处于 FAILED: ${row.error_message ?? 'unknown'}`,
        { level: 'CRITICAL', dedupSec: 1800, tokenAddress: token },
      );
    }
  }
}

export async function logSyncStatusSummary(): Promise<void> {
  for (const cfg of loadMonitorTokens()) {
    const rows = (await listSyncStatus(cfg.tokenAddress)).filter(
      (r) =>
        r.sync_type === 'fast_pair_listener' ||
        r.sync_type === 'slow_transfer_listener',
    );
    const row = rows[0];
    if (!row) continue;
    console.log(
      `[SyncStatus] ${cfg.symbol} last=${row.last_synced_block} lag=${row.lag_blocks} status=${row.status}`,
    );
  }
}
