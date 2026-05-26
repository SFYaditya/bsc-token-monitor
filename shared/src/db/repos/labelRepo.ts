import { dbAll, dbRun } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';

export type AddressLabelType =
  | 'whale'
  | 'bot'
  | 'smart_money'
  | 'project'
  | 'exchange'
  | 'new_wallet';

export async function upsertLabel(input: {
  token_address: string;
  wallet_address: string;
  label: AddressLabelType;
  confidence?: number;
  reason?: string;
}): Promise<void> {
  const now = Date.now();
  await dbRun(
    `INSERT INTO address_label (chain_id, token_address, wallet_address, label, confidence, reason, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (chain_id, token_address, wallet_address, label) DO UPDATE SET
       confidence = EXCLUDED.confidence,
       reason = EXCLUDED.reason,
       updated_at = EXCLUDED.updated_at`,
    [
      CHAIN_ID,
      input.token_address.toLowerCase(),
      input.wallet_address.toLowerCase(),
      input.label,
      input.confidence ?? 1,
      input.reason ?? null,
      now,
    ],
  );

  await dbRun(
    `UPDATE token_holder SET address_tag = ? WHERE token_address = ? AND holder_address = ?`,
    [input.label, input.token_address.toLowerCase(), input.wallet_address.toLowerCase()],
  );
}

export async function getLabels(
  tokenAddress: string,
  walletAddress: string,
): Promise<{ label: string; confidence: number; reason: string | null }[]> {
  return dbAll(
    `SELECT label, confidence, reason FROM address_label
     WHERE token_address = ? AND wallet_address = ? ORDER BY confidence DESC`,
    [tokenAddress.toLowerCase(), walletAddress.toLowerCase()],
  ) as Promise<{ label: string; confidence: number; reason: string | null }[]>;
}

export async function listByLabel(
  tokenAddress: string,
  label: AddressLabelType,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  return dbAll(
    `SELECT l.*, h.balance, h.balance_percent, s.buy_count, s.sell_count, s.total_buy_value, s.total_sell_value
     FROM address_label l
     LEFT JOIN token_holder h ON h.token_address = l.token_address AND h.holder_address = l.wallet_address
     LEFT JOIN token_address_stat s ON s.token_address = l.token_address AND s.wallet_address = l.wallet_address
     WHERE l.token_address = ? AND l.label = ?
     ORDER BY CAST(h.balance AS NUMERIC) DESC NULLS LAST LIMIT ?`,
    [tokenAddress.toLowerCase(), label, limit],
  );
}
