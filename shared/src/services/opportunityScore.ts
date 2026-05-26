import { getTokenMarket, getTokenStats24h } from '../db/repos/marketRepo.js';
import { getStakingStat } from '../db/repos/stakingRepo.js';
import { getLiquidityStat } from '../db/repos/liquidityRepo.js';
import { getRiskScan } from '../db/repos/riskRepo.js';
import { upsertOpportunity } from '../db/repos/opportunityRepo.js';
import { dbGet } from '../db/pg/query.js';

export async function computeOpportunityScore(tokenAddress: string): Promise<{
  score: number;
  trend: 'BULLISH' | 'NEUTRAL' | 'BEARISH';
  bullishSignals: string[];
  bearishSignals: string[];
  riskSignals: string[];
}> {
  const token = tokenAddress.toLowerCase();
  const market = await getTokenMarket(token);
  const stats = await getTokenStats24h(token);
  const staking = await getStakingStat(token);
  const liq = await getLiquidityStat(token);
  const risk = await getRiskScan(token);

  const bullish: string[] = [];
  const bearish: string[] = [];
  const risks: string[] = [];
  let score = 50;

  if (market) {
    if (market.priceChange1h > 2) {
      bullish.push('1小时价格上涨');
      score += 8;
    }
    if (market.priceChange1h < -2) {
      bearish.push('1小时价格下跌');
      score -= 8;
    }
    if (market.priceChange24h > 5) {
      bullish.push('24小时价格上涨');
      score += 5;
    }
    if (market.priceChange24h < -5) {
      bearish.push('24小时价格下跌');
      score -= 5;
    }
  }

  if (stats.netBuyVolume24hUsd > 1000) {
    bullish.push('24h净买入为正');
    score += 10;
  } else if (stats.netBuyVolume24hUsd < -1000) {
    bearish.push('24h净卖出为主');
    score -= 10;
  }

  if (stats.buyCount24h > stats.sellCount24h) {
    bullish.push('买入笔数多于卖出');
    score += 5;
  } else if (stats.sellCount24h > stats.buyCount24h * 1.5) {
    bearish.push('卖出笔数明显偏多');
    score -= 5;
  }

  if (liq) {
    const c24 = Number(liq.change_24h_pct ?? 0);
    if (c24 > 5) {
      bullish.push('流动性增加');
      score += 8;
    }
    if (c24 < -10) {
      bearish.push('流动性减少');
      risks.push('流动性大幅下降');
      score -= 12;
    }
    const burned = Number(liq.lp_burned_pct ?? 0);
    if (burned > 50) bullish.push('LP大量销毁/锁定');
    if (burned < 10 && market && market.liquidityUsd > 0) {
      risks.push('LP锁定比例偏低');
      score -= 5;
    }
  }

  if (staking) {
    const stake24 = BigInt(String(staking.stake_24h ?? '0'));
    const unstake24 = BigInt(String(staking.unstake_24h ?? '0'));
    if (stake24 > unstake24) {
      bullish.push('24h质押净增');
      score += 6;
    } else if (unstake24 > stake24 && unstake24 > 0n) {
      bearish.push('24h解押多于质押');
      score -= 6;
    }
  }

  const since24 = Date.now() - 24 * 60 * 60_000;
  const whaleBuy = await dbGet<{ v: number }>(
    `SELECT COALESCE(SUM(e.amount_usd), 0)::float AS v FROM token_event e
     INNER JOIN address_label l ON l.wallet_address = e.trader AND l.token_address = e.token_address AND l.label = 'whale'
     WHERE e.token_address = ? AND e.event_type = 'buy' AND e.event_time >= ?`,
    [token, since24],
  );
  const whaleSell = await dbGet<{ v: number }>(
    `SELECT COALESCE(SUM(e.amount_usd), 0)::float AS v FROM token_event e
     INNER JOIN address_label l ON l.wallet_address = e.trader AND l.token_address = e.token_address AND l.label = 'whale'
     WHERE e.token_address = ? AND e.event_type = 'sell' AND e.event_time >= ?`,
    [token, since24],
  );
  const whaleNet = Number(whaleBuy?.v ?? 0) - Number(whaleSell?.v ?? 0);
  if (whaleNet > 500) {
    bullish.push('巨鲸24h净买入');
    score += 8;
  } else if (whaleNet < -500) {
    bearish.push('巨鲸24h净卖出');
    score -= 8;
  }

  if (risk) {
    if (risk.risk_level === 'HIGH' || risk.risk_level === 'CRITICAL') {
      risks.push(`合约风险: ${risk.risk_level}`);
      score -= 15;
    }
    const flags = JSON.parse(risk.risk_flags || '[]') as string[];
    if (flags.includes('owner_not_renounced')) risks.push('Owner未放弃');
    if (flags.includes('mint_function')) risks.push('存在mint函数');
    if (flags.includes('blacklist')) risks.push('存在黑名单');
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const trend: 'BULLISH' | 'NEUTRAL' | 'BEARISH' =
    score >= 60 ? 'BULLISH' : score <= 40 ? 'BEARISH' : 'NEUTRAL';

  await upsertOpportunity({
    token_address: token,
    score,
    trend,
    bullish_signals: bullish,
    bearish_signals: bearish,
    risk_signals: risks,
  });

  return { score, trend, bullishSignals: bullish, bearishSignals: bearish, riskSignals: risks };
}
