import type { Provider } from 'ethers';
import { getContract } from '../db/repos/contractRepo.js';
import { getPairByToken } from '../db/repos/pairRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { getMonitorToken, loadMonitorTokens } from '../monitorTokens.js';
import { backfillTokenHolders, syncWatchListHolders } from './holderBackfill.js';
import { rebuildAllHolderProfiles } from './holderProfileSync.js';
import { refreshHolderProfileBalanceUsd } from '../db/repos/holderProfileRepo.js';
import { resolveAddressType } from './addressRegistry.js';
import { dbAll } from '../db/pg/query.js';
import { purgeExcludedHolders } from '../token/holderExclude.js';
import { pruneOrphanHolderProfiles } from './holderReconcile.js';

export interface HolderRepairResult {
  token_address: string;
  symbol: string;
  holders_synced: number;
  profiles_rebuilt: number;
  balance_usd_refreshed: number;
  address_types_resolved: number;
  excluded_purged?: number;
}

/** 回补持仓、重建 holder_profiles、刷新 balance_usd（有市价时） */
export async function repairTokenHolderDatabase(
  provider: Provider,
  tokenAddress: string,
  opts: { forceBackfill?: boolean } = {},
): Promise<HolderRepairResult> {
  const token = tokenAddress.toLowerCase();
  const contract = await getContract(token);
  if (!contract) {
    throw new Error(`未找到 Token 合约记录: ${token}`);
  }

  const cfg = getMonitorToken(token);
  const decimals = cfg?.decimals ?? contract.token_decimals ?? 18;
  const totalSupply = contract.total_supply ?? '0';
  const pair = await getPairByToken(token);
  const pairAddr =
    (cfg?.pairAddress?.trim() || String(pair?.pair_address ?? '')).toLowerCase() ||
    undefined;

  const purged = await purgeExcludedHolders(token);
  await pruneOrphanHolderProfiles(token);

  const bf = await backfillTokenHolders(
    provider,
    token,
    decimals,
    totalSupply,
    pairAddr || undefined,
    { force: opts.forceBackfill ?? !pairAddr },
  );

  const watch = cfg?.watchAddresses ?? [];
  if (watch.length > 0) {
    await syncWatchListHolders(
      provider,
      token,
      decimals,
      totalSupply,
      watch,
      pairAddr || undefined,
    );
  }

  const holders = await dbAll<{ holder_address: string }>(
    `SELECT holder_address FROM token_holder WHERE token_address = ? AND balance != '0'`,
    [token],
  );

  let addressTypesResolved = 0;
  for (const h of holders) {
    const wallet = String(h.holder_address).toLowerCase();
    await resolveAddressType(provider, wallet);
    addressTypesResolved += 1;
  }

  const market = await getTokenMarket(token);
  const priceUsd = market?.priceUsd ?? 0;
  const liquidityUsd = market?.liquidityUsd ?? 0;

  const profilesRebuilt = await rebuildAllHolderProfiles(
    token,
    priceUsd,
    liquidityUsd,
    decimals,
    totalSupply,
  );

  const balanceUsdRefreshed =
    priceUsd > 0 ? await refreshHolderProfileBalanceUsd(token, priceUsd, decimals) : 0;

  await pruneOrphanHolderProfiles(token);
  const { syncMarketHolderCount } = await import('../db/repos/marketRepo.js');
  await syncMarketHolderCount(token);

  return {
    token_address: token,
    symbol: cfg?.symbol ?? contract.token_symbol ?? token.slice(0, 8),
    holders_synced: bf.synced,
    excluded_purged: purged,
    profiles_rebuilt: profilesRebuilt,
    balance_usd_refreshed: balanceUsdRefreshed,
    address_types_resolved: addressTypesResolved,
  };
}

export async function repairAllMonitorTokenDatabases(
  provider: Provider,
  opts: { forceBackfill?: boolean } = {},
): Promise<HolderRepairResult[]> {
  const results: HolderRepairResult[] = [];
  for (const cfg of loadMonitorTokens()) {
    try {
      const r = await repairTokenHolderDatabase(provider, cfg.tokenAddress, opts);
      results.push(r);
      console.log(
        `[HolderRepair] ${r.symbol}: holders=${r.holders_synced} profiles=${r.profiles_rebuilt} usd_refreshed=${r.balance_usd_refreshed}`,
      );
    } catch (err) {
      console.error(
        `[HolderRepair] ${cfg.symbol} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return results;
}
