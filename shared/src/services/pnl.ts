export function computePnl(input: {
  balanceRaw: bigint;
  totalBuyToken: bigint;
  totalSellToken: bigint;
  totalBuyUsd: number;
  totalSellUsd: number;
  priceUsd: number;
  tokenDecimals: number;
}): {
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  roi: number;
} {
  const scale = 10 ** input.tokenDecimals;
  const balanceHuman = Number(input.balanceRaw) / scale;
  const positionValueUsd = balanceHuman * input.priceUsd;

  const soldHuman = Number(input.totalSellToken) / scale;
  const boughtHuman = Number(input.totalBuyToken) / scale;
  const avgCost = boughtHuman > 0 ? input.totalBuyUsd / boughtHuman : 0;

  const costOfSold = avgCost * soldHuman;
  const realizedPnl = input.totalSellUsd - costOfSold;
  const costOfRemaining = avgCost * balanceHuman;
  const unrealizedPnl = positionValueUsd - costOfRemaining;
  const totalPnl = realizedPnl + unrealizedPnl;
  const roi = input.totalBuyUsd > 0 ? (totalPnl / input.totalBuyUsd) * 100 : 0;

  return { unrealizedPnl, realizedPnl, totalPnl, roi };
}
