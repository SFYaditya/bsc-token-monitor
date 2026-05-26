import { dbAll, dbGet, dbRun, dbRunAffected } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import { RAW_EVENT_MAX_RETRIES } from '../../chain/listenerConfig.js';

export async function insertRawEvent(input: {
  token_address?: string;
  contract_address: string;
  event_name: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: number;
  block_hash?: string;
  topic0?: string;
  topics?: string[];
  data?: string;
  decoded_data?: Record<string, unknown>;
  from_address?: string;
  to_address?: string;
}): Promise<boolean> {
  const n = await dbRunAffected(
    `INSERT INTO raw_events (
      chain_id, token_address, contract_address, event_name, tx_hash, log_index,
      block_number, block_hash, block_time, topic0, topics, data, decoded_data,
      from_address, to_address, processed, process_status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)
    ON CONFLICT (chain_id, tx_hash, log_index) DO NOTHING`,
    [
      CHAIN_ID,
      input.token_address?.toLowerCase() ?? null,
      input.contract_address.toLowerCase(),
      input.event_name,
      input.tx_hash,
      input.log_index,
      input.block_number,
      input.block_hash ?? null,
      input.block_time,
      input.topic0 ?? null,
      input.topics ? JSON.stringify(input.topics) : null,
      input.data ?? null,
      input.decoded_data ? JSON.stringify(input.decoded_data) : null,
      input.from_address?.toLowerCase() ?? null,
      input.to_address?.toLowerCase() ?? null,
      Date.now(),
    ],
  );
  return n > 0;
}

export async function rawEventExists(txHash: string, logIndex: number): Promise<boolean> {
  const row = await dbGet(
    `SELECT 1 AS ok FROM raw_events WHERE chain_id = ? AND tx_hash = ? AND log_index = ? LIMIT 1`,
    [CHAIN_ID, txHash, logIndex],
  );
  return !!row;
}

export interface RawEventRow {
  id: number;
  chain_id: number;
  token_address: string | null;
  contract_address: string;
  event_name: string;
  tx_hash: string;
  log_index: number;
  block_number: number;
  block_time: number;
  from_address: string | null;
  to_address: string | null;
  decoded_data: string | null;
  processed: number;
  process_status: string;
  error_message: string | null;
  process_retry_count?: number;
}

export async function listPendingRawEvents(limit = 200): Promise<RawEventRow[]> {
  return (await dbAll(
    `SELECT id, chain_id, token_address, contract_address, event_name, tx_hash, log_index,
            block_number, block_time, from_address, to_address, decoded_data,
            processed, process_status, error_message, process_retry_count
     FROM raw_events
     WHERE chain_id = ? AND processed = 0 AND process_status = 'pending'
     ORDER BY
       CASE event_name WHEN 'Swap' THEN 0 WHEN 'Sync' THEN 1 ELSE 2 END,
       block_number ASC,
       log_index ASC
     LIMIT ?`,
    [CHAIN_ID, Math.min(1000, limit)],
  )) as unknown as RawEventRow[];
}

export async function countPendingRawEvents(): Promise<number> {
  const row = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM raw_events
     WHERE chain_id = ? AND processed = 0 AND process_status = 'pending'`,
    [CHAIN_ID],
  );
  return row?.c ?? 0;
}

export async function countFailedRawEvents(): Promise<number> {
  const row = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM raw_events
     WHERE chain_id = ? AND process_status = 'failed'`,
    [CHAIN_ID],
  );
  return row?.c ?? 0;
}

export async function markRawEventProcessed(
  txHash: string,
  logIndex: number,
  status: 'ok' | 'failed',
  error?: string,
): Promise<void> {
  if (status === 'ok') {
    await dbRun(
      `UPDATE raw_events SET processed = 1, process_status = 'ok', error_message = NULL
       WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
      [CHAIN_ID, txHash, logIndex],
    );
    return;
  }
  const row = await dbGet<{ process_retry_count: number }>(
    `SELECT COALESCE(process_retry_count, 0)::int AS process_retry_count FROM raw_events
     WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
    [CHAIN_ID, txHash, logIndex],
  );
  const retries = Number(row?.process_retry_count ?? 0) + 1;
  if (retries < RAW_EVENT_MAX_RETRIES) {
    await dbRun(
      `UPDATE raw_events SET processed = 0, process_status = 'pending',
              error_message = ?, process_retry_count = ?
       WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
      [error ?? null, retries, CHAIN_ID, txHash, logIndex],
    );
    return;
  }
  await dbRun(
    `UPDATE raw_events SET processed = 1, process_status = 'failed',
            error_message = ?, process_retry_count = ?
     WHERE chain_id = ? AND tx_hash = ? AND log_index = ?`,
    [error ?? null, retries, CHAIN_ID, txHash, logIndex],
  );
}

/** 将超限 failed 事件重置为 pending（运维恢复用） */
export async function requeueFailedRawEvents(limit = 100): Promise<number> {
  const n = await dbRunAffected(
    `UPDATE raw_events SET processed = 0, process_status = 'pending',
            error_message = NULL, process_retry_count = 0
     WHERE id IN (
       SELECT id FROM raw_events
       WHERE chain_id = ? AND process_status = 'failed'
       ORDER BY block_number ASC
       LIMIT ?
     )`,
    [CHAIN_ID, Math.min(500, limit)],
  );
  return n;
}
