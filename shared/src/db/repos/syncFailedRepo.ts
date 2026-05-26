import { dbAll, dbGet, dbRun, dbRunAffected } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import { SYNC_MAX_RETRIES } from '../../chain/listenerConfig.js';
import type { SyncType } from './syncStatusRepo.js';

export async function recordSyncFailure(input: {
  token_address: string;
  sync_type: SyncType;
  block_from: number;
  block_to: number;
  error_message: string;
}): Promise<number> {
  const now = Date.now();
  await dbRun(
    `INSERT INTO sync_failed_blocks (
      chain_id, token_address, sync_type, block_from, block_to,
      error_message, retry_count, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT (chain_id, token_address, sync_type, block_from, block_to) DO UPDATE SET
      error_message = EXCLUDED.error_message,
      retry_count = sync_failed_blocks.retry_count + 1,
      updated_at = EXCLUDED.updated_at`,
    [
      CHAIN_ID,
      input.token_address.toLowerCase(),
      input.sync_type,
      input.block_from,
      input.block_to,
      input.error_message,
      now,
      now,
    ],
  );
  return await getFailureRetryCount(
    input.token_address,
    input.sync_type,
    input.block_from,
    input.block_to,
  );
}

export async function getFailureRetryCount(
  tokenAddress: string,
  syncType: SyncType,
  blockFrom: number,
  blockTo: number,
): Promise<number> {
  const row = await dbGet<{ retry_count: number }>(
    `SELECT retry_count FROM sync_failed_blocks
     WHERE chain_id = ? AND token_address = ? AND sync_type = ?
       AND block_from = ? AND block_to = ?`,
    [CHAIN_ID, tokenAddress.toLowerCase(), syncType, blockFrom, blockTo],
  );
  return Number(row?.retry_count ?? 0);
}

export async function listSyncFailures(
  tokenAddress: string,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  return dbAll(
    `SELECT * FROM sync_failed_blocks
     WHERE chain_id = ? AND token_address = ?
     ORDER BY updated_at DESC LIMIT ?`,
    [CHAIN_ID, tokenAddress.toLowerCase(), limit],
  );
}

export async function clearSyncFailure(
  tokenAddress: string,
  syncType: SyncType,
  blockFrom: number,
  blockTo: number,
): Promise<void> {
  await dbRun(
    `DELETE FROM sync_failed_blocks
     WHERE chain_id = ? AND token_address = ? AND sync_type = ? AND block_from = ? AND block_to = ?`,
    [CHAIN_ID, tokenAddress.toLowerCase(), syncType, blockFrom, blockTo],
  );
}

export async function listPendingRetries(limit = 20): Promise<Record<string, unknown>[]> {
  return dbAll(
    `SELECT * FROM sync_failed_blocks
     WHERE chain_id = ? AND retry_count < ?
     ORDER BY retry_count ASC, updated_at ASC LIMIT ?`,
    [CHAIN_ID, SYNC_MAX_RETRIES, limit],
  );
}

/** 删除已越过游标或低于起始块的失败记录（RPC 无法恢复的历史重试） */
export async function abandonObsoleteSyncFailures(
  tokenAddress: string,
  syncType: SyncType,
  minBlock: number,
): Promise<number> {
  const token = tokenAddress.toLowerCase();
  return dbRunAffected(
    `DELETE FROM sync_failed_blocks
     WHERE chain_id = ? AND token_address = ? AND sync_type = ?
       AND block_to < ?`,
    [CHAIN_ID, token, syncType, minBlock],
  );
}

export async function listExhaustedFailures(limit = 20): Promise<Record<string, unknown>[]> {
  return dbAll(
    `SELECT * FROM sync_failed_blocks
     WHERE chain_id = ? AND retry_count >= ?
     ORDER BY updated_at DESC LIMIT ?`,
    [CHAIN_ID, SYNC_MAX_RETRIES, limit],
  );
}
