#!/usr/bin/env node
/**
 * 一次性将 SQLite 核心表导入 PostgreSQL（需已设置 DATABASE_URL 且 PG schema 已初始化）
 * 用法: node scripts/migrate-sqlite-to-pg.mjs
 */
import Database from 'better-sqlite3';
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR ?? './data';
const DB_FILE = process.env.DB_FILE ?? 'monitor.db';
const dbPath = path.join(DATA_DIR, DB_FILE);
const pgUrl = process.env.DATABASE_URL?.trim();

if (!pgUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`SQLite not found: ${dbPath}`);
  process.exit(1);
}

const TABLES = [
  'token_event',
  'raw_events',
  'token_market_cache',
  'holder_profiles',
  'token_holder',
  'token_address_stat',
  'sync_status',
  'deployed_contract',
  'token_pair',
  'alert_log',
  'system_meta',
];

const sqlite = new Database(dbPath, { readonly: true });
const pool = new pg.Pool({ connectionString: pgUrl });

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

async function copyTable(table) {
  const cols = sqlite.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.length) {
    console.log(`[skip] ${table} (no columns)`);
    return;
  }
  const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
  if (!rows.length) {
    console.log(`[skip] ${table} (empty)`);
    return;
  }
  const colList = cols.join(', ');
  const placeholders = cols.map(() => '?').join(', ');
  const insertSql = toPg(
    `INSERT INTO ${table} (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
  );
  let n = 0;
  for (const row of rows) {
    const vals = cols.map((c) => row[c]);
    try {
      await pool.query(insertSql, vals);
      n++;
    } catch (err) {
      if (String(err?.code) !== '23505') {
        console.warn(`[warn] ${table} row:`, err.message);
      }
    }
  }
  console.log(`[ok] ${table}: ${n}/${rows.length} rows`);
}

async function main() {
  const schemaPath = new URL('../shared/dist/db/pg/schema.js', import.meta.url);
  if (!fs.existsSync(schemaPath)) {
    console.error('Run npm run build -w @token-monitor/shared first');
    process.exit(1);
  }
  const { PG_SCHEMA_STATEMENTS } = await import(schemaPath);
  for (const sql of PG_SCHEMA_STATEMENTS) {
    await pool.query(sql);
  }
  for (const table of TABLES) {
    await copyTable(table);
  }
  await pool.end();
  sqlite.close();
  console.log('Migration finished.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
