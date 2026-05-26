import { dbAll, dbGet, dbRun } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import {
  ENABLE_MASTER_CHEF_LISTENER,
  SYNC_CONFIRM_BLOCKS,
} from '../../chain/listenerConfig.js';
import { loadMonitorTokens, getMonitoredTokenAddresses } from '../../monitorTokens.js';

export type SyncType =
  | 'BLOCK_SCAN'
  | 'CHAIN_EVENTS'
  | 'TOKEN_TRANSFER'
  | 'PAIR_SWAP'
  | 'PAIR_LIQUIDITY'
  | 'LP_TRANSFER'
  | 'STAKING'
  | 'fast_pair_listener'
  | 'medium_masterchef_listener'
  | 'slow_transfer_listener';

export type SyncStatusState = 'RUNNING' | 'PAUSED' | 'FAILED' | 'SYNCED';

export async function ensureSyncStatus(input: {
  token_address: string;
  sync_type: SyncType;
  start_block?: number;
  confirm_blocks?: number;
  scan_interval_blocks?: number;
}): Promise<void> {
  const now = Date.now();
  const start = input.start_block ?? 0;
  const token = input.token_address.toLowerCase();
  const confirm = input.confirm_blocks ?? SYNC_CONFIRM_BLOCKS;
  const scanInterval = input.scan_interval_blocks ?? 2;
  await dbRun(
    `INSERT INTO sync_status (
      chain_id, token_address, sync_type, start_block, last_synced_block,
      confirm_blocks, scan_interval_blocks, status, lag_blocks, heartbeat_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'RUNNING', 0, ?, ?)
    ON CONFLICT (chain_id, token_address, sync_type) DO NOTHING`,
    [
      CHAIN_ID,
      token,
      input.sync_type,
      start,
      Math.max(0, start - 1),
      confirm,
      scanInterval,
      now,
      now,
    ],
  );
}

export async function updateSyncProgress(input: {
  token_address: string;
  sync_type: SyncType;
  last_synced_block?: number;
  latest_block?: number;
  lag_blocks?: number;
  scan_interval_blocks?: number;
  status?: SyncStatusState;
  error_message?: string | null;
  touch_heartbeat?: boolean;
}): Promise<void> {
  const now = Date.now();
  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [now];

  if (input.last_synced_block !== undefined) {
    sets.push('last_synced_block = ?');
    params.push(input.last_synced_block);
  }
  if (input.latest_block !== undefined) {
    sets.push('latest_block = ?');
    params.push(input.latest_block);
  }
  if (input.lag_blocks !== undefined) {
    sets.push('lag_blocks = ?');
    params.push(input.lag_blocks);
  }
  if (input.status !== undefined) {
    sets.push('status = ?');
    params.push(input.status);
  }
  if (input.error_message !== undefined) {
    sets.push('error_message = ?');
    params.push(input.error_message);
  }
  if (input.touch_heartbeat !== false) {
    sets.push('heartbeat_at = ?');
    params.push(now);
  }
  if (input.scan_interval_blocks !== undefined) {
    sets.push('scan_interval_blocks = ?');
    params.push(input.scan_interval_blocks);
  }

  params.push(CHAIN_ID, input.token_address.toLowerCase(), input.sync_type);

  await dbRun(
    `UPDATE sync_status SET ${sets.join(', ')}
     WHERE chain_id = ? AND token_address = ? AND sync_type = ?`,
    params,
  );
}

export async function markSyncFailed(input: {
  token_address: string;
  sync_type: SyncType;
  latest_block?: number;
  lag_blocks?: number;
  error_message: string;
}): Promise<void> {
  await updateSyncProgress({
    token_address: input.token_address,
    sync_type: input.sync_type,
    status: 'FAILED',
    latest_block: input.latest_block,
    lag_blocks: input.lag_blocks,
    error_message: input.error_message,
  });
}

export async function markSyncRunning(input: {
  token_address: string;
  sync_type: SyncType;
  error_message?: string | null;
}): Promise<void> {
  await updateSyncProgress({
    token_address: input.token_address,
    sync_type: input.sync_type,
    status: 'RUNNING',
    error_message: input.error_message ?? null,
  });
}

export async function getSyncCursor(
  tokenAddress: string,
  syncType: SyncType,
): Promise<{
  startBlock: number;
  lastSyncedBlock: number;
  confirmBlocks: number;
  scanIntervalBlocks: number;
  status: SyncStatusState;
  lagBlocks: number;
}> {
  const token = tokenAddress.toLowerCase();
  const row = await dbGet<{
    start_block: number;
    last_synced_block: number;
    confirm_blocks: number;
    scan_interval_blocks: number;
    status: string;
    lag_blocks: number;
  }>(
    `SELECT start_block, last_synced_block, confirm_blocks, scan_interval_blocks, status, lag_blocks
     FROM sync_status
     WHERE chain_id = ? AND token_address = ? AND sync_type = ?`,
    [CHAIN_ID, token, syncType],
  );
  const startBlock = Number(row?.start_block ?? 0);
  const lastSynced = Number(row?.last_synced_block ?? Math.max(0, startBlock - 1));
  return {
    startBlock,
    lastSyncedBlock: lastSynced,
    confirmBlocks: Number(row?.confirm_blocks ?? SYNC_CONFIRM_BLOCKS),
    scanIntervalBlocks: Number(row?.scan_interval_blocks ?? 2),
    status: (row?.status ?? 'RUNNING') as SyncStatusState,
    lagBlocks: Number(row?.lag_blocks ?? 0),
  };
}

/** 从 DB 推断续扫起点：sync_status.last_synced_block、raw_events 最大块、旧 PAIR_SWAP 游标 */
export async function resolveDbResumeBlock(
  tokenAddress: string,
  syncType: SyncType = 'CHAIN_EVENTS',
): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const row = await dbGet<{ last_synced_block: number; start_block: number }>(
    `SELECT last_synced_block, start_block FROM sync_status
     WHERE chain_id = ? AND token_address = ? AND sync_type = ?`,
    [CHAIN_ID, token, syncType],
  );
  const lastSynced = Number(row?.last_synced_block ?? 0);
  const startBlock = Number(row?.start_block ?? 0);

  const rawRow = await dbGet<{ max_block: number | null }>(
    `SELECT MAX(block_number) AS max_block FROM raw_events
     WHERE chain_id = ? AND token_address = ?`,
    [CHAIN_ID, token],
  );
  const maxRaw = Number(rawRow?.max_block ?? 0);

  const legacy = await getSyncCursor(token, 'PAIR_SWAP');
  const fast = await getSyncCursor(token, 'fast_pair_listener').catch(() => null);
  const slow = await getSyncCursor(token, 'slow_transfer_listener').catch(() => null);
  return Math.max(
    lastSynced,
    maxRaw,
    legacy.lastSyncedBlock,
    fast?.lastSyncedBlock ?? 0,
    slow?.lastSyncedBlock ?? 0,
    startBlock,
    0,
  );
}

/** 将 sync_status.start_block 抬升到 DB 已同步高度，避免配置 0 导致重扫历史 */
export async function alignSyncStartFloor(
  tokenAddress: string,
  syncType: SyncType,
  floor: number,
): Promise<void> {
  if (floor <= 0) return;
  const token = tokenAddress.toLowerCase();
  const row = await dbGet<{ start_block: number }>(
    `SELECT start_block FROM sync_status
     WHERE chain_id = ? AND token_address = ? AND sync_type = ?`,
    [CHAIN_ID, token, syncType],
  );
  if (!row) return;
  const next = Math.max(Number(row.start_block ?? 0), floor);
  if (next === Number(row.start_block)) return;
  await dbRun(
    `UPDATE sync_status SET start_block = ?, updated_at = ?
     WHERE chain_id = ? AND token_address = ? AND sync_type = ?`,
    [next, Date.now(), CHAIN_ID, token, syncType],
  );
}

export async function listSyncStatus(tokenAddress?: string): Promise<Record<string, unknown>[]> {
  if (tokenAddress) {
    return dbAll(
      `SELECT * FROM sync_status WHERE chain_id = ? AND token_address = ? ORDER BY sync_type`,
      [CHAIN_ID, tokenAddress.toLowerCase()],
    );
  }
  return dbAll(
    `SELECT * FROM sync_status WHERE chain_id = ? ORDER BY token_address, sync_type`,
    [CHAIN_ID],
  );
}

/** 参与分层监听的 sync_type（勿包含历史遗留 CHAIN_EVENTS 等） */
export function activeMonitorSyncTypes(): SyncType[] {
  const types: SyncType[] = ['fast_pair_listener', 'slow_transfer_listener'];
  if (ENABLE_MASTER_CHEF_LISTENER) {
    types.push('medium_masterchef_listener');
  }
  return types;
}

/** 刷新指定 Token 各活跃 listener 的心跳（不推进块高） */
export async function touchTokenSyncHeartbeats(tokenAddress: string): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const now = Date.now();
  for (const syncType of activeMonitorSyncTypes()) {
    await dbRun(
      `UPDATE sync_status SET heartbeat_at = ?, updated_at = ?
       WHERE chain_id = ? AND token_address = ? AND sync_type = ?`,
      [now, now, CHAIN_ID, token, syncType],
    );
  }
}

export async function touchAllMonitorSyncHeartbeats(): Promise<void> {
  for (const cfg of loadMonitorTokens()) {
    await touchTokenSyncHeartbeats(cfg.tokenAddress);
  }
}

/** 按 Token 聚合：仅当所有活跃 listener 的最新心跳都过期时才视为超时 */
export async function listStaleTokenSyncHeartbeats(
  staleBeforeMs: number,
): Promise<{ token_address: string; last_heartbeat_at: number | null }[]> {
  const cutoff = Date.now() - staleBeforeMs;
  const types = activeMonitorSyncTypes();
  const monitored = [...getMonitoredTokenAddresses()];
  if (!monitored.length) return [];
  const typePh = types.map(() => '?').join(',');
  const tokenPh = monitored.map(() => '?').join(',');
  return (await dbAll(
    `SELECT token_address, MAX(heartbeat_at) AS last_heartbeat_at
     FROM sync_status
     WHERE chain_id = ? AND sync_type IN (${typePh}) AND token_address IN (${tokenPh})
     GROUP BY token_address
     HAVING MAX(heartbeat_at) IS NULL OR MAX(heartbeat_at) < ?`,
    [CHAIN_ID, ...types, ...monitored, cutoff],
  )) as { token_address: string; last_heartbeat_at: number | null }[];
}

/** @deprecated 使用 listStaleTokenSyncHeartbeats */
export async function listStaleSyncHeartbeats(
  staleBeforeMs: number,
): Promise<Record<string, unknown>[]> {
  return listStaleTokenSyncHeartbeats(staleBeforeMs) as unknown as Record<string, unknown>[];
}

export async function listHighLagSync(maxLag: number): Promise<Record<string, unknown>[]> {
  const monitored = [...getMonitoredTokenAddresses()];
  if (!monitored.length) return [];
  const placeholders = monitored.map(() => '?').join(',');
  return dbAll(
    `SELECT * FROM sync_status
     WHERE chain_id = ? AND token_address IN (${placeholders})
       AND sync_type = 'fast_pair_listener'
       AND lag_blocks > ? AND status != 'PAUSED'
     ORDER BY lag_blocks DESC`,
    [CHAIN_ID, ...monitored, maxLag],
  );
}
