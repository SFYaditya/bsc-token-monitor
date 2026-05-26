/** 巨鲸分级与标签（与后端 whaleGrading 字段对齐） */

export type HoldingTierId =
  | 'small'
  | 'normal'
  | 'large'
  | 'whale'
  | 'super_whale';

export type LiquidityImpactId = 'low' | 'medium' | 'high' | 'extreme';

export type BehaviorTagId =
  | 'new_whale'
  | 'accumulating'
  | 'reducing'
  | 'cleared'
  | 'long_term_holder'
  | 'short_term_arbitrage'
  | 'staking_whale'
  | 'unstake_watch';

export interface GradingPayload {
  walletAddress?: string;
  balanceRaw?: string;
  holdingUsd: number;
  holdingTier: HoldingTierId;
  holdingTierLabel: string;
  liquidityImpact: LiquidityImpactId;
  liquidityImpactLabel: string;
  liquidityImpactPct: number;
  behaviorTags: BehaviorTagId[];
  behaviorTagLabels: string[];
  stakingBalanceRaw?: string;
}

export function tierBadgeClass(tier: string): string {
  switch (tier) {
    case 'super_whale':
      return 'badge-tier-super';
    case 'whale':
      return 'badge-whale';
    case 'large':
      return 'badge-tier-large';
    case 'normal':
      return 'badge-tier-normal';
    default:
      return 'badge-neutral';
  }
}

export function impactBadgeClass(impact: string): string {
  switch (impact) {
    case 'extreme':
      return 'badge-impact-extreme';
    case 'high':
      return 'badge-impact-high';
    case 'medium':
      return 'badge-impact-medium';
    default:
      return 'badge-impact-low';
  }
}

export function tagBadgeClass(tag: string): string {
  switch (tag) {
    case 'new_whale':
      return 'badge-tag-new';
    case 'accumulating':
      return 'badge-buy';
    case 'reducing':
    case 'cleared':
      return 'badge-sell';
    case 'long_term_holder':
      return 'badge-tag-hold';
    case 'short_term_arbitrage':
      return 'badge-warn';
    case 'staking_whale':
      return 'badge-stake';
    case 'unstake_watch':
      return 'badge-tag-unstake';
    default:
      return 'badge-neutral';
  }
}
