/** 单笔成交的 USD 单价：与成交额 amount_usd、token 数量一致 */
export function tradePriceUsdFromEvent(
  amountUsd: number,
  tokenAmountRaw: string | number | bigint,
  decimals: number,
  fallbackPrice = 0,
): number {
  const raw = BigInt(String(tokenAmountRaw || '0'));
  if (raw <= 0n || !Number.isFinite(amountUsd) || amountUsd <= 0) {
    return fallbackPrice > 0 ? fallbackPrice : 0;
  }
  const human = Number(raw) / 10 ** decimals;
  if (human <= 0) return fallbackPrice > 0 ? fallbackPrice : 0;
  const implied = amountUsd / human;
  return implied > 0 ? implied : fallbackPrice > 0 ? fallbackPrice : 0;
}
