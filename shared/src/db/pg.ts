import pg from 'pg';

let pool: pg.Pool | null = null;
let readPool: pg.Pool | null = null;

export function isPostgresEnabled(): boolean {
  const url = process.env.DATABASE_URL?.trim() ?? '';
  return url.startsWith('postgres://') || url.startsWith('postgresql://');
}

/** API 从只读副本读大盘（需 PG_READ_ENABLED=true 且副本有数据） */
export function isPgReadEnabled(): boolean {
  return process.env.PG_READ_ENABLED === 'true' && isPostgresEnabled();
}

export function getPgPool(): pg.Pool | null {
  if (!isPostgresEnabled()) return null;
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX ?? 8),
    });
  }
  return pool;
}

/** 只读副本；未配置 DATABASE_READ_URL 时回退主库 */
export function getPgReadPool(): pg.Pool | null {
  if (!isPostgresEnabled()) return null;
  const readUrl = process.env.DATABASE_READ_URL?.trim();
  if (!readUrl) return getPgPool();
  if (!readPool) {
    readPool = new pg.Pool({
      connectionString: readUrl,
      max: Number(process.env.PG_READ_POOL_MAX ?? 4),
    });
  }
  return readPool;
}

export async function pgQuery<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const p = getPgPool();
  if (!p) return [];
  const res = await p.query<T>(sql, params);
  return res.rows;
}

export async function pgReadQuery<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const p = getPgReadPool();
  if (!p) return [];
  const res = await p.query<T>(sql, params);
  return res.rows;
}

export async function pgExec(sql: string, params: unknown[] = []): Promise<void> {
  const p = getPgPool();
  if (!p) return;
  await p.query(sql, params);
}

export async function closePgPools(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (readPool) {
    await readPool.end();
    readPool = null;
  }
}
