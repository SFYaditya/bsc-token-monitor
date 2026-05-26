import { dbGet, dbRun } from '../pg/query.js';

export interface RiskScanRow {
  token_address: string;
  owner_address: string | null;
  owner_renounced: number;
  can_mint: number;
  has_blacklist: number;
  trading_disabled: number;
  risk_level: string;
  risk_flags: string;
  scanned_at: number;
}

export async function upsertRiskScan(
  row: Omit<RiskScanRow, 'token_address'> & { token_address: string },
): Promise<void> {
  await dbRun(
    `INSERT INTO token_risk_scan (
      token_address, owner_address, owner_renounced, can_mint, has_blacklist,
      trading_disabled, risk_level, risk_flags, scanned_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (token_address) DO UPDATE SET
      owner_address = EXCLUDED.owner_address,
      owner_renounced = EXCLUDED.owner_renounced,
      can_mint = EXCLUDED.can_mint,
      has_blacklist = EXCLUDED.has_blacklist,
      trading_disabled = EXCLUDED.trading_disabled,
      risk_level = EXCLUDED.risk_level,
      risk_flags = EXCLUDED.risk_flags,
      scanned_at = EXCLUDED.scanned_at`,
    [
      row.token_address.toLowerCase(),
      row.owner_address?.toLowerCase() ?? null,
      row.owner_renounced,
      row.can_mint,
      row.has_blacklist,
      row.trading_disabled,
      row.risk_level,
      row.risk_flags,
      row.scanned_at,
    ],
  );
}

export async function getRiskScan(tokenAddress: string): Promise<RiskScanRow | null> {
  const row = (await dbGet(
    'SELECT * FROM token_risk_scan WHERE token_address = ?',
    [tokenAddress.toLowerCase()],
  )) as RiskScanRow | undefined;
  return row ?? null;
}
