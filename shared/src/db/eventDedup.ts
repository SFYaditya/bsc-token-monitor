import { dbGet } from './pg/query.js';
import { CHAIN_ID } from '../config.js';

/** token_event 已存在则视为已处理 */
export async function eventExists(
  tokenAddress: string,
  txHash: string,
  logIndex: number,
): Promise<boolean> {
  const row = await dbGet(
    `SELECT 1 AS ok FROM token_event
     WHERE chain_id = ? AND token_address = ? AND tx_hash = ? AND log_index = ? LIMIT 1`,
    [CHAIN_ID, tokenAddress.toLowerCase(), txHash, logIndex],
  );
  return !!row;
}

export async function getRawEventStatus(
  txHash: string,
  logIndex: number,
): Promise<'pending' | 'ok' | 'failed' | null> {
  const row = await dbGet<{ process_status: string }>(
    `SELECT process_status FROM raw_events
     WHERE chain_id = ? AND tx_hash = ? AND log_index = ? LIMIT 1`,
    [CHAIN_ID, txHash, logIndex],
  );
  if (!row) return null;
  const s = row.process_status;
  if (s === 'ok' || s === 'failed' || s === 'pending') return s;
  return 'pending';
}

/** raw_events 已成功处理则跳过（failed 允许重试） */
export async function shouldSkipChainEvent(
  tokenAddress: string,
  txHash: string,
  logIndex: number,
): Promise<boolean> {
  const raw = await getRawEventStatus(txHash, logIndex);
  if (raw === 'ok') return true;
  return eventExists(tokenAddress, txHash, logIndex);
}
