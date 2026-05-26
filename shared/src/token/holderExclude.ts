import { ZeroAddress } from 'ethers';
import { CHAIN_ID, PANCAKE_FACTORY, PANCAKE_ROUTER } from '../config.js';
import { dbRun, dbRunAffected } from '../db/pg/query.js';
import { getPairByToken } from '../db/repos/pairRepo.js';

/** 不应出现在持仓榜的地址（Pair、Router、零地址等） */
export async function collectExcludedHolderAddresses(
  tokenAddress: string,
): Promise<Set<string>> {
  const token = tokenAddress.toLowerCase();
  const excluded = new Set<string>([
    ZeroAddress,
    PANCAKE_FACTORY,
    PANCAKE_ROUTER,
    token,
  ]);
  const pair = await getPairByToken(token);
  if (pair?.pair_address) {
    excluded.add(String(pair.pair_address).toLowerCase());
  }
  if (pair?.token0) excluded.add(String(pair.token0).toLowerCase());
  if (pair?.token1) excluded.add(String(pair.token1).toLowerCase());
  return excluded;
}

export async function isExcludedHolderAddress(
  tokenAddress: string,
  wallet: string,
): Promise<boolean> {
  return (await collectExcludedHolderAddresses(tokenAddress)).has(wallet.toLowerCase());
}

export async function purgeExcludedHolders(tokenAddress: string): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const excluded = [...(await collectExcludedHolderAddresses(token))];
  if (!excluded.length) return 0;
  let removed = 0;
  for (const w of excluded) {
    removed += await dbRunAffected(
      `DELETE FROM token_holder WHERE chain_id = ? AND token_address = ? AND holder_address = ?`,
      [CHAIN_ID, token, w],
    );
    await dbRun(
      `DELETE FROM holder_profiles WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
      [CHAIN_ID, token, w],
    );
    await dbRun(
      `DELETE FROM token_address_stat WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
      [CHAIN_ID, token, w],
    );
  }
  return removed;
}
