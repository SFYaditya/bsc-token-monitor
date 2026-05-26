import { zhAlertType } from './locale';
import { tradeSizeLabel, tradeSizeBadgeClass } from './tradeSize';

const TRADE_ALERT_TYPES = new Set([
  'large_buy',
  'large_sell',
  'whale_buy',
  'whale_sell',
  'whale_first_buy',
  'project_sell',
  'unstake_then_sell',
  'whale_clear',
]);

export function isUsdTradeAlert(alertType: string, amountUsd?: unknown): boolean {
  const t = String(alertType ?? '').toLowerCase();
  const usd = Number(amountUsd ?? 0);
  if (usd > 0 && (t.includes('buy') || t.includes('sell') || t.includes('买') || t.includes('卖'))) {
    return true;
  }
  return TRADE_ALERT_TYPES.has(t) && usd > 0;
}

export function tradeSideFromAlertType(alertType: string): 'buy' | 'sell' | null {
  const t = String(alertType ?? '').toLowerCase();
  if (t.includes('buy') || t.includes('买')) return 'buy';
  if (t.includes('sell') || t.includes('卖') || t.includes('clear') || t.includes('撤')) return 'sell';
  return null;
}

export function tradeSideBadgeClass(alertType: string): string {
  const side = tradeSideFromAlertType(alertType);
  if (side === 'buy') return 'badge-buy';
  if (side === 'sell') return 'badge-sell';
  return 'badge-warn';
}

export function tradeSideLabel(alertType: string): string {
  const side = tradeSideFromAlertType(alertType);
  if (side === 'buy') return '买入';
  if (side === 'sell') return '卖出';
  return '';
}

/** 买卖类告警：方向 + 成交额分档标签；其余告警沿用原中文类型 */
export function formatAlertTypeDisplay(alertType: string, amountUsd?: unknown): {
  isTrade: boolean;
  sideLabel: string;
  sideClass: string;
  sizeLabel: string;
  sizeClass: string;
  fallbackLabel: string;
} {
  const type = String(alertType ?? '');
  const usd = Number(amountUsd ?? 0);
  if (isUsdTradeAlert(type, usd)) {
    return {
      isTrade: true,
      sideLabel: tradeSideLabel(type),
      sideClass: tradeSideBadgeClass(type),
      sizeLabel: tradeSizeLabel(usd),
      sizeClass: tradeSizeBadgeClass(usd),
      fallbackLabel: zhAlertType(type),
    };
  }
  return {
    isTrade: false,
    sideLabel: '',
    sideClass: 'badge-warn',
    sizeLabel: '',
    sizeClass: 'badge-neutral',
    fallbackLabel: zhAlertType(type),
  };
}
