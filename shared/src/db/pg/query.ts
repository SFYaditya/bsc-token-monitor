import { getPgPool, isPostgresEnabled, pgExec, pgQuery } from '../pg.js';
import { getPgTx } from './transaction.js';

/** 将 SQLite 风格 ? 占位符转为 PostgreSQL $1,$2,... */
export function toPgSql(sql: string): string {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

export function requirePostgres(): void {
  if (!isPostgresEnabled()) {
    throw new Error('DATABASE_URL 未配置：本项目需要 PostgreSQL，请设置 postgresql://...');
  }
}

export async function waitForPostgres(maxMs = 90_000): Promise<void> {
  requirePostgres();
  const deadline = Date.now() + maxMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      await pgQuery('SELECT 1 AS ok');
      return;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `PostgreSQL 未就绪: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

async function runQuery<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const tx = getPgTx();
  if (tx) {
    const res = await tx.query<T>(sql, params);
    return res.rows;
  }
  return pgQuery<T>(toPgSql(sql), params);
}

async function runExec(sql: string, params: unknown[] = []): Promise<void> {
  const tx = getPgTx();
  if (tx) {
    await tx.query(sql, params);
    return;
  }
  await pgExec(toPgSql(sql), params);
}

async function runAffected(sql: string, params: unknown[] = []): Promise<number> {
  const tx = getPgTx();
  if (tx) {
    const res = await tx.query(sql, params);
    return res.rowCount ?? 0;
  }
  const pool = getPgPool();
  if (!pool) throw new Error('PG pool unavailable');
  const res = await pool.query(toPgSql(sql), params);
  return res.rowCount ?? 0;
}

export async function dbAll<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return runQuery<T>(sql, params);
}

export async function dbGet<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await dbAll<T>(sql, params);
  return rows[0];
}

export async function dbRun(sql: string, params: unknown[] = []): Promise<void> {
  await runExec(sql, params);
}

export async function dbRunReturningId(
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const pool = getPgPool();
  if (!pool) throw new Error('PG pool unavailable');
  const res = await pool.query<{ id: number }>(`${toPgSql(sql)} RETURNING id`, params);
  return Number(res.rows[0]?.id ?? 0);
}

export async function dbInsertReturning<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined> {
  const rows = await pgQuery<T>(`${toPgSql(sql)} RETURNING *`, params);
  return rows[0];
}

export async function dbRunAffected(sql: string, params: unknown[] = []): Promise<number> {
  return runAffected(sql, params);
}

export { withPgTransaction, isInPgTransaction } from './transaction.js';
