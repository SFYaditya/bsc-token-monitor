import { getHolderBalance } from '../db/repos/holderRepo.js';
import { dbGet, dbAll } from '../db/pg/query.js';
import { computeAddressGrading } from './whaleGrading.js';
import { computePnl } from './pnl.js';
import { getHolderProfile, upsertHolderProfile } from '../db/repos/holderProfileRepo.js';
import {
  getLpStakingConfig,
  getTokenLpStakingStat,
  rebuildProfileLpFields,
  resolveLpUsdFields,
  sumLpStakedFromRecords,
} from './catLpStaking.js';
import { isExcludedHolderAddress } from '../token/holderExclude.js';
import { publishRealtimeThrottled } from '../realtime/throttle.js';
import { balanceUsdFromRaw } from '../token/balanceMath.js';
import { CHAIN_ID } from '../config.js';

export async function syncHolderProfileForWallet(input: {
  token_address: string;
  wallet_address: string;
  price_usd: number;
  liquidity_usd: number;
  decimals: number;
  total_supply: string;
  pushRealtime?: boolean;
  address_type?: string;
  is_contract?: number;
  balance_source?: 'EVENT_ESTIMATED' | 'ONCHAIN_CONFIRMED';
  last_balance_checked_at?: number | null;
}): Promise<void> {
  const token = input.token_address.toLowerCase();
  const wallet = input.wallet_address.toLowerCase();
  if (await isExcludedHolderAddress(token, wallet)) return;
  const walletBalance = await getHolderBalance(token, wallet) ?? '0';
  if (BigInt(walletBalance) <= 0n) {
    if (!(await hasStatRow(token, wallet))) return;
    await import('../db/pg/query.js').then((m) =>
      m.dbRun(
        `DELETE FROM holder_profiles WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
        [CHAIN_ID, token, wallet],
      ),
    );
    return;
  }

  const stat = await dbGet<Record<string, unknown>>(
    `SELECT * FROM token_address_stat WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, token, wallet],
  );

  const stakingBalance = String(stat?.staking_balance ?? '0');
  const totalBalWei = BigInt(walletBalance || '0') + BigInt(stakingBalance || '0');
  const supply = BigInt(input.total_supply || '0');
  const pct =
    supply > 0n ? Number((totalBalWei * 10000n) / supply) / 100 : 0;

  const grading = await computeAddressGrading(
    token,
    wallet,
    input.price_usd,
    input.liquidity_usd,
    input.decimals,
  );

  const scale = 10 ** input.decimals;
  const buyTok = BigInt(String(stat?.total_buy_token ?? '0'));
  const sellTok = BigInt(String(stat?.total_sell_token ?? '0'));
  const buyUsd = Number(stat?.total_buy_value ?? 0);
  const sellUsd = Number(stat?.total_sell_value ?? 0);
  const pnl = computePnl({
    balanceRaw: BigInt(walletBalance || '0'),
    totalBuyToken: buyTok,
    totalSellToken: sellTok,
    totalBuyUsd: buyUsd,
    totalSellUsd: sellUsd,
    priceUsd: input.price_usd,
    tokenDecimals: input.decimals,
  });
  const avgBuy =
    buyTok > 0n ? buyUsd / (Number(buyTok) / scale) : 0;
  const avgSell =
    sellTok > 0n ? sellUsd / (Number(sellTok) / scale) : 0;

  const firstBuy = stat?.first_buy_time != null ? Number(stat.first_buy_time) : null;
  const isNew =
    firstBuy != null && firstBuy >= Date.now() - 24 * 60 * 60_000;

  const totalBal = (BigInt(walletBalance) + BigInt(stakingBalance)).toString();
  const balanceUsdVal = balanceUsdFromRaw(
    totalBal,
    input.decimals,
    input.price_usd,
  );

  const existingHp = await getHolderProfile(token, wallet);

  await upsertHolderProfile({
    token_address: token,
    wallet_address: wallet,
    wallet_balance: walletBalance,
    staking_balance: stakingBalance,
    lp_balance: existingHp?.lp_balance,
    lp_staked_balance: existingHp?.lp_staked_balance,
    balance_percent: pct,
    stat: stat ?? null,
    grading,
    pnl: {
      avgBuyPrice: avgBuy,
      avgSellPrice: avgSell,
      ...pnl,
    },
    is_new_wallet: isNew,
    address_type: input.address_type ?? 'wallet',
    is_contract: input.is_contract ?? 0,
    price_usd: input.price_usd,
    token_decimals: input.decimals,
    balance_source: input.balance_source,
    last_balance_checked_at: input.last_balance_checked_at,
  });

  const lpCfg = getLpStakingConfig(token);
  if (lpCfg) {
    const stakedFromRecords = await sumLpStakedFromRecords(token, wallet);
    const lpBal = BigInt(existingHp?.lp_balance ?? '0');
    if (
      stakedFromRecords !== BigInt(existingHp?.lp_staked_balance ?? '0') ||
      (stakedFromRecords > 0n && lpBal >= 0n)
    ) {
      try {
        await rebuildProfileLpFields(
          token,
          wallet,
          lpBal,
          stakedFromRecords > 0n ? stakedFromRecords : 0n,
        );
      } catch {
        /* 保留已有 LP 字段 */
      }
    }
  }

  const hpLatest = (await getHolderProfile(token, wallet)) ?? existingHp;
  const lpStat = await getTokenLpStakingStat(token);
  const lpUsd = resolveLpUsdFields(
    hpLatest?.lp_balance ?? '0',
    hpLatest?.lp_staked_balance ?? '0',
    input.liquidity_usd,
    String(lpStat?.total_lp_supply ?? '0'),
  );

  if (input.pushRealtime === true && grading) {
    void publishRealtimeThrottled({
      type: 'holder_update',
      tokenAddress: token,
      data: {
        walletAddress: wallet,
        addressType: input.address_type ?? 'wallet',
        isContract: (input.is_contract ?? 0) === 1,
        walletBalance,
        stakingBalance,
        lpBalanceRaw: hpLatest?.lp_balance ?? '0',
        lpStakedBalanceRaw: hpLatest?.lp_staked_balance ?? '0',
        lpBalanceUsd: lpUsd.lpBalanceUsd,
        lpStakedBalanceUsd: lpUsd.lpStakedBalanceUsd,
        totalBalance: (BigInt(walletBalance) + BigInt(stakingBalance)).toString(),
        balanceUsd: balanceUsdVal || grading?.holdingUsd || 0,
        holderLevel: grading.holdingTier,
        behaviorTags: grading.behaviorTags,
        buyCount: Number(stat?.buy_count ?? 0),
        sellCount: Number(stat?.sell_count ?? 0),
        totalBuyAmount: String(stat?.total_buy_token ?? '0'),
        totalSellAmount: String(stat?.total_sell_token ?? '0'),
        netBuyAmount: (
          BigInt(String(stat?.total_buy_token ?? '0')) -
          BigInt(String(stat?.total_sell_token ?? '0'))
        ).toString(),
        lastTradeTime: stat?.last_trade_time != null ? Number(stat.last_trade_time) : null,
        updatedAt: Date.now(),
      },
    });
  }
}

async function hasStatRow(token: string, wallet: string): Promise<boolean> {
  const row = await dbGet(
    `SELECT 1 AS ok FROM token_address_stat WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, token, wallet],
  );
  return !!row;
}

export async function rebuildAllHolderProfiles(
  tokenAddress: string,
  priceUsd: number,
  liquidityUsd: number,
  decimals: number,
  totalSupply: string,
): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const rows = await dbAll<{ holder_address: string }>(
    `SELECT holder_address FROM token_holder WHERE chain_id = ? AND token_address = ? AND balance != '0'`,
    [CHAIN_ID, token],
  );
  for (const r of rows) {
    const wallet = String(r.holder_address);
    if (await isExcludedHolderAddress(token, wallet)) continue;
    await syncHolderProfileForWallet({
      token_address: token,
      wallet_address: wallet,
      price_usd: priceUsd,
      liquidity_usd: liquidityUsd,
      decimals,
      total_supply: totalSupply,
      pushRealtime: false,
    });
  }
  return rows.length;
}
