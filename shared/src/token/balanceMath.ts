/** 大数余额占比，避免 Number 精度丢失 */
export function calcBalancePercent(balance: bigint, totalSupply: bigint): number {
  if (totalSupply <= 0n || balance <= 0n) return 0;
  return Number((balance * 1_000_000n) / totalSupply) / 10_000;
}

export function compareBalanceDesc(a: string | bigint, b: string | bigint): number {
  const ba = typeof a === 'bigint' ? a : BigInt(String(a || '0'));
  const bb = typeof b === 'bigint' ? b : BigInt(String(b || '0'));
  if (bb > ba) return 1;
  if (bb < ba) return -1;
  return 0;
}

/** SQLite 无 uint256：用长度 + 十进制字符串比较 wei 余额 */
export function bigintTextOrderSql(column: string, dir: 'asc' | 'desc'): string {
  const d = dir === 'asc' ? 'ASC' : 'DESC';
  return `ORDER BY LENGTH(${column}) ${d}, ${column} ${d}`;
}

export function balanceUsdFromRaw(
  balanceRaw: string | bigint,
  decimals: number,
  priceUsd: number,
): number {
  if (priceUsd <= 0) return 0;
  const raw = typeof balanceRaw === 'bigint' ? balanceRaw : BigInt(String(balanceRaw || '0'));
  if (raw <= 0n) return 0;
  return (Number(raw) / 10 ** decimals) * priceUsd;
}

/** V2 LP 份额价值：份额 × 池子总流动性 USD */
export function lpValueUsdFromShare(
  lpAmountRaw: string | bigint,
  totalLpSupplyRaw: string | bigint,
  poolLiquidityUsd: number,
): number {
  if (poolLiquidityUsd <= 0) return 0;
  const amt = typeof lpAmountRaw === 'bigint' ? lpAmountRaw : BigInt(String(lpAmountRaw || '0'));
  const supply =
    typeof totalLpSupplyRaw === 'bigint'
      ? totalLpSupplyRaw
      : BigInt(String(totalLpSupplyRaw || '0'));
  if (amt <= 0n || supply <= 0n) return 0;
  return (Number(amt) / Number(supply)) * poolLiquidityUsd;
}
