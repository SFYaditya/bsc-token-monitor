import type { Provider } from 'ethers';
import { dbRun, dbRunAffected } from '../db/pg/query.js';
import { syncMarketHolderCount } from '../db/repos/marketRepo.js';
import { collectExcludedHolderAddresses } from '../token/holderExclude.js';
import { rebuildAllHolderProfiles } from './holderProfileSync.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getMonitorToken } from '../monitorTokens.js';
import { fetchBalance } from '../token/erc20.js';
import { deleteHolder } from '../db/repos/holderRepo.js';
import { dbAll } from '../db/pg/query.js';
import { CHAIN_ID } from '../config.js';

/** 删除 holder_profiles 中在 token_holder 无有效持仓的行 */
export async function pruneOrphanHolderProfiles(tokenAddress: string): Promise<number> {
  const token = tokenAddress.toLowerCase();
  return dbRunAffected(
    `DELETE FROM holder_profiles hp
     WHERE hp.chain_id = ? AND hp.token_address = ?
       AND NOT EXISTS (
         SELECT 1 FROM token_holder th
         WHERE th.chain_id = hp.chain_id
           AND th.token_address = hp.token_address
           AND th.holder_address = hp.wallet_address
           AND th.balance IS NOT NULL
           AND th.balance != '0'
           AND th.balance != ''
       )`,
    [CHAIN_ID, token],
  );
}

/** 链上余额为 0 的 token_holder / profiles 清理 */
export async function pruneZeroBalanceHolders(
  provider: Provider,
  tokenAddress: string,
): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const rows = await dbAll<{ holder_address: string }>(
    `SELECT holder_address FROM token_holder WHERE token_address = ? AND balance != '0'`,
    [token],
  );
  let removed = 0;
  for (const r of rows) {
    const wallet = String(r.holder_address).toLowerCase();
    if (await collectExcludedHolderAddresses(token).then((s) => s.has(wallet))) {
      await deleteHolder(token, wallet);
      removed++;
      continue;
    }
    try {
      const bal = await fetchBalance(provider, token, wallet);
      if (bal <= 0n) {
        await deleteHolder(token, wallet);
        await dbRun(
          `DELETE FROM holder_profiles WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
          [CHAIN_ID, token, wallet],
        );
        removed++;
      }
    } catch {
      /* keep row if RPC fails */
    }
  }
  return removed;
}

/** 对齐 token_holder / holder_profiles / market_cache.holder_count */
export async function reconcileHolderData(
  provider: Provider,
  tokenAddress: string,
): Promise<{
  orphans_removed: number;
  zero_pruned: number;
  holder_count: number;
  profile_count: number;
}> {
  const token = tokenAddress.toLowerCase();
  const cfg = getMonitorToken(token);
  const contract = await getContract(token);
  const decimals = cfg?.decimals ?? contract?.token_decimals ?? 18;
  const totalSupply = contract?.total_supply ?? '0';

  const orphans = await pruneOrphanHolderProfiles(token);
  const zeroPruned = await pruneZeroBalanceHolders(provider, token);

  const market = await getTokenMarket(token);
  const priceUsd = market?.priceUsd ?? 0;
  const liquidityUsd = market?.liquidityUsd ?? 0;

  await rebuildAllHolderProfiles(
    token,
    priceUsd,
    liquidityUsd,
    decimals,
    totalSupply,
  );
  await pruneOrphanHolderProfiles(token);
  await syncMarketHolderCount(token);

  const { countHolders } = await import('../db/repos/statRepo.js');
  const { listHolderProfiles } = await import('../db/repos/holderProfileRepo.js');
  const holderCount = await countHolders(token);
  const profiled = await listHolderProfiles(token, { page: 1, pageSize: 1 });

  return {
    orphans_removed: orphans,
    zero_pruned: zeroPruned,
    holder_count: holderCount,
    profile_count: profiled.total,
  };
}
