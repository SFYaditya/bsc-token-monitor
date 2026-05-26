import { dbAll, dbGet } from '../db/pg/query.js';
import { WHALE_RULE } from '../config.js';
import { upsertLabel, type AddressLabelType } from '../db/repos/labelRepo.js';
import { loadProjectAddresses } from '../monitorTokens.js';
import { computePnl } from './pnl.js';
import { getContract } from '../db/repos/contractRepo.js';

export async function classifyTokenAddresses(
  tokenAddress: string,
  priceUsd: number,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const contract = await getContract(token);
  const decimals = contract?.token_decimals ?? 18;
  const projectAddrs = new Set(loadProjectAddresses());

  const deployer = contract?.deployer_address?.toLowerCase();
  if (deployer) projectAddrs.add(deployer);

  const holders = await dbAll<Record<string, unknown>>(
    `SELECT h.holder_address, h.balance, h.balance_percent, s.*
     FROM token_holder h
     LEFT JOIN token_address_stat s ON s.token_address = h.token_address AND s.wallet_address = h.holder_address
     WHERE h.token_address = ? AND h.balance != '0'`,
    [token],
  );

  const since1h = Date.now() - 60 * 60_000;

  for (const h of holders) {
    const wallet = String(h.holder_address).toLowerCase();
    const balance = BigInt(String(h.balance ?? '0'));
    const balanceUsd = (Number(balance) / 10 ** decimals) * priceUsd;
    const pct = Number(h.balance_percent ?? 0);

    if (projectAddrs.has(wallet)) {
      await upsertLabel({
        token_address: token,
        wallet_address: wallet,
        label: 'project',
        confidence: 1,
        reason: 'configured_or_deployer',
      });
    }

    if (
      balanceUsd >= WHALE_RULE.minHoldingUsd ||
      pct >= WHALE_RULE.minHoldingPercent
    ) {
      await upsertLabel({
        token_address: token,
        wallet_address: wallet,
        label: 'whale',
        confidence: 0.9,
        reason: 'holding_threshold',
      });
    }

    const buyCount = Number(h.buy_count ?? 0);
    const sellCount = Number(h.sell_count ?? 0);
    const tradesRow = await dbGet<{ c: number }>(
      `SELECT COUNT(*)::int AS c FROM token_event
       WHERE token_address = ? AND trader = ? AND event_type IN ('buy','sell') AND event_time >= ?`,
      [token, wallet, since1h],
    );
    const trades1h = tradesRow?.c ?? 0;

    if (trades1h >= 15 || buyCount + sellCount >= 80) {
      await upsertLabel({
        token_address: token,
        wallet_address: wallet,
        label: 'bot',
        confidence: 0.75,
        reason: 'high_trade_frequency',
      });
    }

    const pnl = computePnl({
      balanceRaw: balance,
      totalBuyToken: BigInt(String(h.total_buy_token ?? '0')),
      totalSellToken: BigInt(String(h.total_sell_token ?? '0')),
      totalBuyUsd: Number(h.total_buy_value ?? 0),
      totalSellUsd: Number(h.total_sell_value ?? 0),
      priceUsd,
      tokenDecimals: decimals,
    });

    if (
      pnl.roi > 30 &&
      Number(h.total_buy_value ?? 0) > 200 &&
      buyCount >= 1
    ) {
      await upsertLabel({
        token_address: token,
        wallet_address: wallet,
        label: 'smart_money',
        confidence: Math.min(0.95, 0.5 + pnl.roi / 200),
        reason: `roi_${pnl.roi.toFixed(0)}pct`,
      });
    }

    const firstBuy = h.first_buy_time != null ? Number(h.first_buy_time) : null;
    if (firstBuy && buyCount === 1 && sellCount === 0) {
      const age = Date.now() - firstBuy;
      if (age < 3 * 24 * 60 * 60_000) {
        await upsertLabel({
          token_address: token,
          wallet_address: wallet,
          label: 'new_wallet',
          confidence: 0.8,
          reason: 'recent_first_buy',
        });
      }
    }
  }
}

export function isProjectAddress(wallet: string): boolean {
  const addrs = new Set(loadProjectAddresses());
  return addrs.has(wallet.toLowerCase());
}

export async function getPrimaryLabel(
  tokenAddress: string,
  wallet: string,
): Promise<AddressLabelType | null> {
  const row = await dbGet<{ label: AddressLabelType }>(
    `SELECT label FROM address_label WHERE token_address = ? AND wallet_address = ?
     ORDER BY confidence DESC LIMIT 1`,
    [tokenAddress.toLowerCase(), wallet.toLowerCase()],
  );
  return row?.label ?? null;
}
