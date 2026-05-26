/** 单笔成交额（USD）分档标签 */

export type TradeSizeTierId =
  | 'micro'
  | 'small'
  | 'medium'
  | 'large'
  | 'whale'
  | 'super_whale';

export const TRADE_SIZE_TIER_LABEL_ZH: Record<TradeSizeTierId, string> = {
  micro: '微量',
  small: '小额',
  medium: '中额',
  large: '大额',
  whale: '鲸鱼',
  super_whale: '巨鲸',
};

/** 按 USD 成交额解析分档（边界：100 / 500 / 2000 / 5000 / 10000） */
export function resolveTradeSizeTier(amountUsd: number): TradeSizeTierId {
  const u = Number(amountUsd);
  if (!Number.isFinite(u) || u < 100) return 'micro';
  if (u < 500) return 'small';
  if (u < 2000) return 'medium';
  if (u < 5000) return 'large';
  if (u < 10000) return 'whale';
  return 'super_whale';
}

export function resolveTradeSizeLabel(amountUsd: number): string {
  return TRADE_SIZE_TIER_LABEL_ZH[resolveTradeSizeTier(amountUsd)];
}
