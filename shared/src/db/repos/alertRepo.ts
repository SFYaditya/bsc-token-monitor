import { CHAIN_ID, TG_NOTIFY_RPC } from '../../config.js';
import { dbAll, dbGet, dbRun, dbRunAffected, dbRunReturningId } from '../pg/query.js';
import type { AlertEventRow } from '../../types.js';

/** 告警中心保留时长，默认 12 小时 */
export const ALERT_LOG_RETENTION_MS = Math.max(
  60_000,
  Number(process.env.ALERT_LOG_RETENTION_MS ?? 12 * 60 * 60_000),
);

/** 删除超过保留期的告警记录 */
export async function purgeAlertsOlderThan(
  maxAgeMs = ALERT_LOG_RETENTION_MS,
): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  return dbRunAffected(`DELETE FROM alert_log WHERE created_at < ?`, [cutoff]);
}

export async function insertAlert(input: {
  alert_type: string;
  token_address?: string;
  pair_address?: string;
  tx_hash?: string;
  wallet_address?: string;
  amount_usd?: number;
  level?: string;
  message: string;
  send_status: string;
}): Promise<number> {
  return dbRunReturningId(
    `INSERT INTO alert_log (
      chain_id, alert_type, token_address, pair_address, tx_hash, wallet_address, amount_usd,
      level, message, channel, send_status, handled, retry_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'panel', ?, 0, 0, ?)`,
    [
      CHAIN_ID,
      input.alert_type,
      input.token_address?.toLowerCase() ?? null,
      input.pair_address?.toLowerCase() ?? null,
      input.tx_hash ?? null,
      input.wallet_address?.toLowerCase() ?? null,
      input.amount_usd ?? null,
      input.level ?? 'MEDIUM',
      input.message,
      input.send_status,
      Date.now(),
    ],
  );
}

const MAX_TG_RETRIES = 8;

export async function updateAlertSendStatus(
  id: number,
  sendStatus: string,
  telegramError?: string | null,
): Promise<void> {
  await dbRun(
    `UPDATE alert_log SET send_status = ?, telegram_error = COALESCE(?, telegram_error),
     retry_count = retry_count + CASE WHEN ? IN ('failed','pending') THEN 1 ELSE 0 END
     WHERE id = ?`,
    [sendStatus, telegramError ?? null, sendStatus, id],
  );
}

export async function listAlertsPendingTelegram(limit = 50): Promise<
  (AlertEventRow & {
    send_status: string;
    telegram_error: string | null;
    retry_count: number;
  })[]
> {
  return (await dbAll(
    `SELECT id, alert_type, token_address, level, wallet_address, tx_hash, amount_usd, message,
            handled, created_at, send_status, telegram_error, retry_count
     FROM alert_log
     WHERE send_status IN ('pending', 'failed')
       AND channel = 'panel'
       AND retry_count < ?
     ORDER BY created_at ASC
     LIMIT ?`,
    [MAX_TG_RETRIES, limit],
  )) as unknown as (AlertEventRow & {
    send_status: string;
    telegram_error: string | null;
    retry_count: number;
  })[];
}

export async function listAlerts(
  opts: {
    token_address?: string;
    page?: number;
    pageSize?: number;
  } = {},
): Promise<{ items: AlertEventRow[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = Math.min(200, opts.pageSize ?? 50);
  const offset = (page - 1) * pageSize;
  const conditions: string[] = ['1=1'];
  const params: unknown[] = [];
  if (opts.token_address) {
    conditions.push('token_address = ?');
    params.push(opts.token_address.toLowerCase());
  }
  if (!TG_NOTIFY_RPC) {
    conditions.push("alert_type NOT LIKE 'rpc_%'");
  }
  const where = conditions.join(' AND ');
  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM alert_log WHERE ${where}`,
    params,
  );
  const total = totalRow?.c ?? 0;
  const items = (await dbAll(
    `SELECT id, alert_type, token_address, level, wallet_address, tx_hash, amount_usd, message, handled, created_at
     FROM alert_log WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  )) as unknown as AlertEventRow[];
  return { items, total };
}
