/** 与 shared/trade/tradeSizeLabel 保持一致 */

export type TradeSizeTierId =
  | 'micro'
  | 'small'
  | 'medium'
  | 'large'
  | 'whale'
  | 'super_whale';

const LABELS: Record<TradeSizeTierId, string> = {
  micro: '微量',
  small: '小额',
  medium: '中额',
  large: '大额',
  whale: '鲸鱼',
  super_whale: '巨鲸',
};

export function resolveTradeSizeTier(amountUsd: number): TradeSizeTierId {
  const u = Number(amountUsd);
  if (!Number.isFinite(u) || u < 100) return 'micro';
  if (u < 500) return 'small';
  if (u < 2000) return 'medium';
  if (u < 5000) return 'large';
  if (u < 10000) return 'whale';
  return 'super_whale';
}

export function tradeSizeLabel(amountUsd: number): string {
  return LABELS[resolveTradeSizeTier(amountUsd)];
}

export function tradeSizeBadgeClass(amountUsd: number): string {
  switch (resolveTradeSizeTier(amountUsd)) {
    case 'super_whale':
      return 'badge-tier-super';
    case 'whale':
      return 'badge-whale';
    case 'large':
      return 'badge-tier-large';
    case 'medium':
      return 'badge-warn';
    default:
      return 'badge-neutral';
  }
}
