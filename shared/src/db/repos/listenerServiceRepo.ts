import { dbAll, dbGet, dbRun } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import { getMonitoredTokenAddresses } from '../../monitorTokens.js';
import type { SyncStatusState } from './syncStatusRepo.js';

export type ListenerServiceState = 'RUNNING' | 'DEGRADED' | 'FAILED';

export async function ensureListenerService(serviceName: string): Promise<void> {
  const now = Date.now();
  await dbRun(
    `INSERT INTO listener_service (
      service_name, status, heartbeat_at, updated_at
    ) VALUES (?, 'RUNNING', ?, ?)
    ON CONFLICT (service_name) DO NOTHING`,
    [serviceName, now, now],
  );
}

export async function touchListenerHeartbeat(input: {
  service_name: string;
  status?: ListenerServiceState;
  latest_block?: number;
  lag_blocks?: number;
  error_message?: string | null;
}): Promise<void> {
  const now = Date.now();
  await ensureListenerService(input.service_name);
  await dbRun(
    `UPDATE listener_service SET
      heartbeat_at = ?,
      status = COALESCE(?, status),
      latest_block = COALESCE(?, latest_block),
      lag_blocks = COALESCE(?, lag_blocks),
      error_message = ?,
      updated_at = ?
     WHERE service_name = ?`,
    [
      now,
      input.status ?? null,
      input.latest_block ?? null,
      input.lag_blocks ?? null,
      input.error_message ?? null,
      now,
      input.service_name,
    ],
  );
}

export async function getListenerService(
  serviceName: string,
): Promise<Record<string, unknown> | undefined> {
  return dbGet(
    `SELECT * FROM listener_service WHERE service_name = ?`,
    [serviceName],
  );
}

export async function maxTokenLagBlocks(): Promise<number> {
  const monitored = [...getMonitoredTokenAddresses()];
  if (!monitored.length) return 0;
  const placeholders = monitored.map(() => '?').join(',');
  const row = await dbGet<{ max_lag: number | null }>(
    `SELECT MAX(lag_blocks) AS max_lag FROM sync_status
     WHERE chain_id = ? AND sync_type = 'fast_pair_listener' AND token_address IN (${placeholders})`,
    [CHAIN_ID, ...monitored],
  );
  return Number(row?.max_lag ?? 0);
}

export async function listRunningSyncRows(): Promise<Record<string, unknown>[]> {
  return dbAll(
    `SELECT * FROM sync_status WHERE status IN ('RUNNING', 'FAILED', 'SYNCED')`,
  );
}

export type { SyncStatusState };
