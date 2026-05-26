export function shortAddr(a: string, headChars = 4, tailChars = 6): string {
  if (!a || a.length < headChars + tailChars + 3) return a;
  return `${a.slice(0, headChars)}...${a.slice(-tailChars)}`;
}

export function bscTx(hash: string): string {
  return `https://bscscan.com/tx/${hash}`;
}

export function bscAddr(addr: string): string {
  return `https://bscscan.com/address/${addr}`;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

export function fmtTimeShort(ms: number): string {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

export function fmtPct(n: number, signed = true): string {
  const p = `${Math.abs(n).toFixed(2)}%`;
  if (!signed) return p;
  return n >= 0 ? `+${p}` : `-${p}`;
}

export function fmtTokenAmount(raw: string | number, decimals = 18, maxFrac = 6): string {
  const v = BigInt(String(raw || '0'));
  if (v === 0n) return '0';
  const scale = 10n ** BigInt(decimals);
  const whole = v / scale;
  const frac = v % scale;
  const fracStr = frac
    .toString()
    .padStart(decimals, '0')
    .replace(/0+$/, '')
    .slice(0, maxFrac);
  if (!fracStr) return whole.toLocaleString('zh-CN');
  return `${whole.toLocaleString('zh-CN')}.${fracStr}`;
}

export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n === 0) return '—';
  if (n >= 1) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

export function riskBadge(level: string | undefined): string {
  const l = String(level ?? '').toLowerCase();
  if (l.includes('high') || l.includes('高')) return 'badge-sell';
  if (l.includes('medium') || l.includes('中')) return 'badge-warn';
  return 'badge-buy';
}

export function trendBadge(trend: string | undefined): string {
  const t = String(trend ?? '').toUpperCase();
  if (t === 'BULLISH') return 'badge-buy';
  if (t === 'BEARISH') return 'badge-sell';
  return 'badge-neutral';
}

export {
  zhTrend as fmtTrend,
  zhEventType as fmtEventType,
  zhRiskLevel as fmtRiskLevel,
  zhAlertType as fmtAlertType,
  zhAlertLevel as fmtAlertLevel,
  zhAddressLabel as fmtAddressLabel,
  zhTokenStatus as fmtTokenStatus,
  zhApiError,
  UI,
} from './locale.js';
