import { CHAIN_ID } from '../../config.js';
import { dbAll, dbGet, dbRun, dbRunAffected } from '../pg/query.js';

const MAX_REMARK_LEN = 64;

export function normalizeWalletRemark(raw: string): string {
  return String(raw ?? '')
    .trim()
    .slice(0, MAX_REMARK_LEN);
}

export async function getWalletRemark(
  tokenAddress: string,
  walletAddress: string,
): Promise<string | null> {
  const row = await dbGet<{ remark: string }>(
    `SELECT remark FROM wallet_address_remark
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, tokenAddress.toLowerCase(), walletAddress.toLowerCase()],
  );
  const remark = row?.remark?.trim();
  return remark || null;
}

export async function listWalletRemarks(
  tokenAddress: string,
): Promise<{ wallet_address: string; remark: string; updated_at: number }[]> {
  return dbAll(
    `SELECT wallet_address, remark, updated_at FROM wallet_address_remark
     WHERE chain_id = ? AND token_address = ?
     ORDER BY updated_at DESC`,
    [CHAIN_ID, tokenAddress.toLowerCase()],
  );
}

export async function upsertWalletRemark(
  tokenAddress: string,
  walletAddress: string,
  remark: string,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();
  const text = normalizeWalletRemark(remark);
  if (!text) {
    await deleteWalletRemark(token, wallet);
    return;
  }
  const now = Date.now();
  await dbRun(
    `INSERT INTO wallet_address_remark (
      chain_id, token_address, wallet_address, remark, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (chain_id, token_address, wallet_address) DO UPDATE SET
      remark = EXCLUDED.remark,
      updated_at = EXCLUDED.updated_at`,
    [CHAIN_ID, token, wallet, text, now, now],
  );
}

export async function deleteWalletRemark(
  tokenAddress: string,
  walletAddress: string,
): Promise<boolean> {
  const n = await dbRunAffected(
    `DELETE FROM wallet_address_remark
     WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, tokenAddress.toLowerCase(), walletAddress.toLowerCase()],
  );
  return n > 0;
}
