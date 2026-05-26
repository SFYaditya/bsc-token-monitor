import { CHAIN_ID, MONITOR_WALLET } from '../config.js';
import { closePgPools, isPostgresEnabled } from './pg.js';
import { initPgSchema } from './pg/init.js';
import { dbGet, dbRun, requirePostgres, waitForPostgres } from './pg/query.js';

/** @deprecated SQLite 已移除；调用将抛错 */
export function getDb(): never {
  throw new Error(
    'SQLite 已停用。请设置 DATABASE_URL=postgresql://... 并使用 async 数据访问（dbGet/dbRun 或 repo async 方法）。',
  );
}

export async function ensureDbReady(): Promise<void> {
  requirePostgres();
  await waitForPostgres();
  await initPgSchema();
}

export function isSqliteSchemaReady(): boolean {
  return isPostgresEnabled();
}

export async function closeDb(): Promise<void> {
  await closePgPools();
}

export async function getMeta(key: string): Promise<string | null> {
  const row = await dbGet<{ value: string }>(
    'SELECT value FROM system_meta WHERE key = ?',
    [key],
  );
  return row?.value ?? null;
}

export async function setMeta(key: string, value: string): Promise<void> {
  await dbRun(
    `INSERT INTO system_meta (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, value, Date.now()],
  );
}

export async function seedMonitorWallet(): Promise<void> {
  const now = Date.now();
  await dbRun(
    `INSERT INTO monitor_wallet (chain_id, wallet_address, remark, enabled, created_at, updated_at)
     VALUES (?, ?, 'default', 1, ?, ?)
     ON CONFLICT (wallet_address) DO NOTHING`,
    [CHAIN_ID, MONITOR_WALLET, now, now],
  );
}
