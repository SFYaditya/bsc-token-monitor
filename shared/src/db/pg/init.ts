import { CHAIN_ID, MONITOR_WALLET } from '../../config.js';
import { getPgPool, getPgReadPool, isPostgresEnabled } from '../pg.js';
import { PG_SCHEMA_ALTERS, PG_SCHEMA_STATEMENTS } from './schema.js';

const SCHEMA_LOCK_KEY = 0x746f6b65; // 固定 advisory lock，多容器串行建表
const SCHEMA_VERSION_KEY = 'pg_schema_version';
const SCHEMA_VERSION = '1';

let schemaReady = false;

function isBenignPgSchemaError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  // 42P07=duplicate_table, 42710=duplicate_object, 23505=unique_violation（并发 CREATE SERIAL 序列）
  return code === '42P07' || code === '42710' || code === '23505';
}

async function execSchemaSql(
  query: (text: string) => Promise<unknown>,
  sql: string,
): Promise<void> {
  try {
    await query(sql);
  } catch (err) {
    if (!isBenignPgSchemaError(err)) throw err;
  }
}

async function tryAcquireSchemaLock(
  client: { query: (text: string, values?: unknown[]) => Promise<{ rows: { ok?: boolean }[] }> },
  maxWaitMs = 45_000,
): Promise<boolean> {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const r = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [SCHEMA_LOCK_KEY]);
    if (r.rows[0]?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
}

async function runSchemaAlters(
  query: (text: string) => Promise<unknown>,
): Promise<void> {
  for (const sql of PG_SCHEMA_ALTERS) {
    await execSchemaSql(query, sql);
  }
}

export async function initPgSchema(): Promise<void> {
  if (!isPostgresEnabled() || schemaReady) return;
  const pool = getPgPool();
  if (!pool) return;

  let schemaInitialized = false;
  try {
    const existing = await pool.query<{ value: string }>(
      `SELECT value FROM system_meta WHERE key = $1`,
      [SCHEMA_VERSION_KEY],
    );
    schemaInitialized = existing.rows[0]?.value === SCHEMA_VERSION;
  } catch {
    /* system_meta 可能尚未创建 */
  }

  if (schemaInitialized) {
    const alterClient = await pool.connect();
    try {
      await runSchemaAlters((s) => alterClient.query(s));
    } finally {
      alterClient.release();
    }
    schemaReady = true;
    return;
  }

  const client = await pool.connect();
  try {
    if (!(await tryAcquireSchemaLock(client, 90_000))) {
      throw new Error('PostgreSQL schema 初始化锁等待超时');
    }

    for (const sql of PG_SCHEMA_STATEMENTS) {
      await execSchemaSql((s) => client.query(s), sql);
    }
    await runSchemaAlters((s) => client.query(s));

    const now = Date.now();
    await client.query(
      `INSERT INTO monitor_wallet (chain_id, wallet_address, remark, enabled, created_at, updated_at)
       VALUES ($1, $2, 'default', 1, $3, $3)
       ON CONFLICT (wallet_address) DO NOTHING`,
      [CHAIN_ID, MONITOR_WALLET.toLowerCase(), now],
    );

    await client.query(
      `INSERT INTO system_meta (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [SCHEMA_VERSION_KEY, SCHEMA_VERSION, now],
    );

    schemaReady = true;
    console.log('[PG] schema ready');
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY]);
    } catch {
      /* connection may already be broken */
    }
    client.release();
  }
}

const PG_TABLE_WHITELIST = new Set([
  'token_market_cache',
  'token_event',
  'holder_profiles',
  'raw_events',
  'deployed_contract',
  'sync_status',
]);

export async function pgTableHasRows(table: string): Promise<boolean> {
  if (!PG_TABLE_WHITELIST.has(table)) return false;
  const pool = getPgReadPool() ?? getPgPool();
  if (!pool) return false;
  try {
    const res = await pool.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${table} LIMIT 1`);
    return Number(res.rows[0]?.c ?? 0) > 0;
  } catch {
    return false;
  }
}
