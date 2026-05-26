import { dbAll, dbGet, dbRun, dbRunAffected } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';
import type { TokenStatus } from '../../lifecycle.js';

export interface DeployedContractRow {
  id: number;
  contract_address: string;
  deployer_address: string;
  tx_hash: string;
  block_number: number;
  deploy_time: number;
  is_token: number;
  token_name: string | null;
  token_symbol: string | null;
  token_decimals: number | null;
  total_supply: string | null;
  status: TokenStatus;
}

export async function insertDeployedContract(input: {
  deployer_address: string;
  contract_address: string;
  tx_hash: string;
  block_number: number;
  deploy_time: number;
  is_token: boolean;
  token_name?: string;
  token_symbol?: string;
  token_decimals?: number;
  total_supply?: string;
  status?: TokenStatus;
}): Promise<boolean> {
  const now = Date.now();
  try {
    const n = await dbRunAffected(
      `INSERT INTO deployed_contract (
        chain_id, deployer_address, contract_address, tx_hash, block_number, deploy_time,
        is_token, token_name, token_symbol, token_decimals, total_supply, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (contract_address) DO NOTHING`,
      [
        CHAIN_ID,
        input.deployer_address.toLowerCase(),
        input.contract_address.toLowerCase(),
        input.tx_hash,
        input.block_number,
        input.deploy_time,
        input.is_token ? 1 : 0,
        input.token_name ?? null,
        input.token_symbol ?? null,
        input.token_decimals ?? null,
        input.total_supply ?? null,
        input.status ?? 'deployed_no_liquidity',
        now,
        now,
      ],
    );
    return n > 0;
  } catch {
    return false;
  }
}

export async function getContract(address: string): Promise<DeployedContractRow | undefined> {
  return (await dbGet(
    'SELECT * FROM deployed_contract WHERE contract_address = ?',
    [address.toLowerCase()],
  )) as DeployedContractRow | undefined;
}

export async function listContracts(opts: {
  status?: string;
  page?: number;
  pageSize?: number;
} = {}): Promise<{ items: DeployedContractRow[]; total: number }> {
  const page = opts.page ?? 1;
  const pageSize = Math.min(100, opts.pageSize ?? 20);
  const offset = (page - 1) * pageSize;
  const conditions = ['is_token = 1'];
  const params: unknown[] = [];
  if (opts.status) {
    conditions.push('status = ?');
    params.push(opts.status);
  }
  const where = conditions.join(' AND ');
  const totalRow = await dbGet<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM deployed_contract WHERE ${where}`,
    params,
  );
  const total = totalRow?.c ?? 0;
  const items = (await dbAll(
    `SELECT * FROM deployed_contract WHERE ${where} ORDER BY deploy_time DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  )) as unknown as DeployedContractRow[];
  return { items, total };
}

export async function updateContractStatus(address: string, status: TokenStatus): Promise<void> {
  await dbRun(
    'UPDATE deployed_contract SET status = ?, updated_at = ? WHERE contract_address = ?',
    [status, Date.now(), address.toLowerCase()],
  );
}

/** 导入或更新已监控 Token（按合约地址 upsert） */
export async function upsertImportedContract(input: {
  deployer_address: string;
  contract_address: string;
  tx_hash: string;
  block_number: number;
  deploy_time: number;
  is_token: boolean;
  token_name?: string;
  token_symbol?: string;
  token_decimals?: number;
  total_supply?: string;
  status?: TokenStatus;
}): Promise<void> {
  const now = Date.now();
  const addr = input.contract_address.toLowerCase();
  await dbRun(
    `INSERT INTO deployed_contract (
      chain_id, deployer_address, contract_address, tx_hash, block_number, deploy_time,
      is_token, token_name, token_symbol, token_decimals, total_supply, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (contract_address) DO UPDATE SET
      deployer_address = EXCLUDED.deployer_address,
      token_name = EXCLUDED.token_name,
      token_symbol = EXCLUDED.token_symbol,
      token_decimals = EXCLUDED.token_decimals,
      total_supply = EXCLUDED.total_supply,
      status = EXCLUDED.status,
      is_token = EXCLUDED.is_token,
      updated_at = EXCLUDED.updated_at`,
    [
      CHAIN_ID,
      input.deployer_address.toLowerCase(),
      addr,
      input.tx_hash,
      input.block_number,
      input.deploy_time,
      input.is_token ? 1 : 0,
      input.token_name ?? null,
      input.token_symbol ?? null,
      input.token_decimals ?? null,
      input.total_supply ?? null,
      input.status ?? 'deployed_no_liquidity',
      now,
      now,
    ],
  );
}

export async function countByStatus(): Promise<Record<string, number>> {
  const rows = await dbAll<{ status: string; c: number }>(
    `SELECT status, COUNT(*)::int AS c FROM deployed_contract WHERE is_token = 1 GROUP BY status`,
  );
  const out: Record<string, number> = {};
  for (const r of rows) out[r.status] = r.c;
  return out;
}
