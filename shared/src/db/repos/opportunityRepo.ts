import { dbGet, dbRun } from '../pg/query.js';

export interface OpportunityRow {
  token_address: string;
  score: number;
  trend: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  bullish_signals: string;
  bearish_signals: string;
  risk_signals: string;
  updated_at: number;
}

export async function upsertOpportunity(row: {
  token_address: string;
  score: number;
  trend: OpportunityRow['trend'];
  bullish_signals: string[];
  bearish_signals: string[];
  risk_signals: string[];
}): Promise<void> {
  await dbRun(
    `INSERT INTO opportunity_score (
      token_address, score, trend, bullish_signals, bearish_signals, risk_signals, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (token_address) DO UPDATE SET
      score = EXCLUDED.score,
      trend = EXCLUDED.trend,
      bullish_signals = EXCLUDED.bullish_signals,
      bearish_signals = EXCLUDED.bearish_signals,
      risk_signals = EXCLUDED.risk_signals,
      updated_at = EXCLUDED.updated_at`,
    [
      row.token_address.toLowerCase(),
      row.score,
      row.trend,
      JSON.stringify(row.bullish_signals),
      JSON.stringify(row.bearish_signals),
      JSON.stringify(row.risk_signals),
      Date.now(),
    ],
  );
}

export async function getOpportunity(tokenAddress: string): Promise<{
  score: number;
  trend: string;
  bullishSignals: string[];
  bearishSignals: string[];
  riskSignals: string[];
  updatedAt: number;
} | null> {
  const row = (await dbGet(
    'SELECT * FROM opportunity_score WHERE token_address = ?',
    [tokenAddress.toLowerCase()],
  )) as OpportunityRow | undefined;
  if (!row) return null;
  return {
    score: row.score,
    trend: row.trend,
    bullishSignals: JSON.parse(row.bullish_signals || '[]') as string[],
    bearishSignals: JSON.parse(row.bearish_signals || '[]') as string[],
    riskSignals: JSON.parse(row.risk_signals || '[]') as string[],
    updatedAt: row.updated_at,
  };
}
