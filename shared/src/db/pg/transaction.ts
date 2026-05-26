import { AsyncLocalStorage } from 'node:async_hooks';
import type pg from 'pg';
import { getPgPool } from '../pg.js';
import { toPgSql } from './query.js';

export type PgTxClient = {
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>;
};

const txStorage = new AsyncLocalStorage<PgTxClient>();

export function getPgTx(): PgTxClient | undefined {
  return txStorage.getStore();
}

export function isInPgTransaction(): boolean {
  return txStorage.getStore() !== undefined;
}

function clientFromPoolClient(client: pg.PoolClient): PgTxClient {
  return {
    query<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) {
      return client.query<T>(toPgSql(sql), params);
    },
  };
}

/** 在单库事务中执行；repo 层 dbRun/dbGet 自动走同一连接 */
export async function withPgTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const pool = getPgPool();
  if (!pool) throw new Error('PG pool unavailable');
  const client = await pool.connect();
  const tx = clientFromPoolClient(client);
  try {
    await client.query('BEGIN');
    const result = await txStorage.run(tx, fn);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
