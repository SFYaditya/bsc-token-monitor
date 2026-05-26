/** 与 shared/tradeBalanceDisplay 相同逻辑，供前端列表展示 */
export function displayTradeBalanceAfterForSwap(
  row: {
    event_type?: string;
    trade_type?: string;
    token_amount?: string;
    balance_after?: string;
  },
  newerSameWallet?: {
    event_type?: string;
    trade_type?: string;
    token_amount?: string;
    balance_after?: string;
  } | null,
): string {
  const bal = BigInt(String(row.balance_after ?? '0'));
  const amt = BigInt(String(row.token_amount ?? '0'));
  const side = String(row.event_type ?? row.trade_type ?? '').toLowerCase();
  if (amt <= 0n || (side !== 'sell' && side !== 'buy')) return bal.toString();

  if (newerSameWallet) {
    const nb = BigInt(String(newerSameWallet.balance_after ?? '0'));
    const na = BigInt(String(newerSameWallet.token_amount ?? '0'));
    if (side === 'sell' && nb + na === bal) {
      return (bal > amt ? bal - amt : 0n).toString();
    }
    if (side === 'buy' && nb > na && nb - na === bal) {
      return (bal + amt).toString();
    }
  }

  return bal.toString();
}

export function enrichSwapRowsBalanceAfter(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const copy = rows.map((r) => ({ ...r }));
  const byTrader = new Map<string, Record<string, unknown>[]>();

  for (const row of copy) {
    const w = String(row.trader ?? row.wallet_address ?? '').toLowerCase();
    if (!w) continue;
    const list = byTrader.get(w) ?? [];
    list.push(row);
    byTrader.set(w, list);
  }

  for (const list of byTrader.values()) {
    list.sort((a, b) => {
      const tb = Number(b.event_time ?? b.block_time ?? 0) - Number(a.event_time ?? a.block_time ?? 0);
      if (tb !== 0) return tb;
      return String(b.tx_hash ?? '').localeCompare(String(a.tx_hash ?? ''));
    });
    for (let i = 0; i < list.length; i++) {
      const newer = i > 0 ? list[i - 1]! : null;
      list[i]!.balance_after = displayTradeBalanceAfterForSwap(list[i]!, newer);
    }
  }

  return copy;
}

export function patchFromNewTrade(data: Record<string, unknown>): {
  wallet: string;
  balanceRaw: string;
  buyCount: number;
  sellCount: number;
  lastTradeTime: number | null;
} | null {
  const wallet = String(data.walletAddress ?? '').toLowerCase();
  if (!wallet) return null;
  return {
    wallet,
    balanceRaw: String(data.balanceAfter ?? '0'),
    buyCount: Number(data.buyCountAfter ?? 0),
    sellCount: Number(data.sellCountAfter ?? 0),
    lastTradeTime: data.blockTime != null ? Number(data.blockTime) : null,
  };
}
