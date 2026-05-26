/** API/表格统一字段：token_transactions 用 block_time、trade_type */
export function normalizeTradeRow(row: Record<string, unknown>): Record<string, unknown> {
  let eventType = String(row.event_type ?? row.trade_type ?? '').toLowerCase();
  if (eventType !== 'buy' && eventType !== 'sell') {
    const side = String(row.side ?? '').toLowerCase();
    if (side.includes('buy')) eventType = 'buy';
    else if (side.includes('sell')) eventType = 'sell';
  }
  return {
    ...row,
    id: row.id ?? `${row.tx_hash}-${row.log_index ?? 0}`,
    event_time: Number(row.event_time ?? row.block_time ?? 0),
    event_type: eventType,
    amount_usd: Number(row.amount_usd ?? 0),
    tx_hash: row.tx_hash,
    quote_balance_after: row.quote_balance_after ?? null,
  };
}

/** 展示用：修正历史 Swap 误存为成交前余额的 balance_after */
export function displayTradeBalanceAfterForSwap(
  row: {
    trade_type?: string;
    token_amount?: string;
    balance_after?: string;
  },
  newerSameWallet?: {
    trade_type?: string;
    token_amount?: string;
    balance_after?: string;
  } | null,
): string {
  const bal = BigInt(String(row.balance_after ?? '0'));
  const amt = BigInt(String(row.token_amount ?? '0'));
  const side = String(row.trade_type ?? '').toLowerCase();
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

export function enrichTradeRowsBalanceAfter(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  const copy = rows.map((r) => ({ ...r }));
  const byWallet = new Map<string, Record<string, unknown>[]>();

  for (const row of copy) {
    const w = String(row.wallet_address ?? row.trader ?? '').toLowerCase();
    if (!w) continue;
    const list = byWallet.get(w) ?? [];
    list.push(row);
    byWallet.set(w, list);
  }

  for (const list of byWallet.values()) {
    list.sort((a, b) => {
      const tb =
        Number(b.block_time ?? b.event_time ?? 0) - Number(a.block_time ?? a.event_time ?? 0);
      if (tb !== 0) return tb;
      return Number(b.log_index ?? 0) - Number(a.log_index ?? 0);
    });
    for (let i = 0; i < list.length; i++) {
      const newer = i > 0 ? list[i - 1]! : null;
      list[i]!.balance_after = displayTradeBalanceAfterForSwap(
        {
          trade_type: String(list[i]!.trade_type ?? list[i]!.event_type ?? ''),
          token_amount: String(list[i]!.token_amount ?? '0'),
          balance_after: String(list[i]!.balance_after ?? '0'),
        },
        newer
          ? {
              trade_type: String(newer.trade_type ?? newer.event_type ?? ''),
              token_amount: String(newer.token_amount ?? '0'),
              balance_after: String(newer.balance_after ?? '0'),
            }
          : null,
      );
    }
  }

  return copy;
}
