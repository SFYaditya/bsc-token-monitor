import type { Provider } from 'ethers';
import { fetchBalance } from './erc20.js';
import { calcBalancePercent } from './balanceMath.js';
import { deleteHolder, upsertHolder } from '../db/repos/holderRepo.js';
import { updateStatBalance } from '../db/repos/statRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { syncHolderProfileForWallet } from '../services/holderProfileSync.js';

export async function syncHolderBalance(
  provider: Provider,
  tokenAddress: string,
  wallet: string,
  decimals: number,
  totalSupplyRaw: string,
  pairAddress?: string,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const w = wallet.toLowerCase();
  if (pairAddress && w === pairAddress.toLowerCase()) return;

  const balance = await fetchBalance(provider, token, w);
  const supply = BigInt(totalSupplyRaw || '0');
  const pct = calcBalancePercent(balance, supply);

  if (balance === 0n) {
    deleteHolder(token, w);
    updateStatBalance(token, w, '0', true);
    return;
  }

  upsertHolder({
    token_address: token,
    holder_address: w,
    balance: balance.toString(),
    balance_percent: pct,
    last_active_time: Date.now(),
  });
  updateStatBalance(token, w, balance.toString(), false);

  const market = await getTokenMarket(token);
  syncHolderProfileForWallet({
    token_address: token,
    wallet_address: w,
    price_usd: market?.priceUsd ?? 0,
    liquidity_usd: market?.liquidityUsd ?? 0,
    decimals,
    total_supply: totalSupplyRaw,
  });
}

/** DEX 路径：pair Transfer 仍要更新用户余额 */
export async function syncPairSideBalances(
  provider: Provider,
  tokenAddress: string,
  from: string,
  to: string,
  decimals: number,
  totalSupply: string,
  pairAddress?: string,
): Promise<void> {
  const pair = pairAddress?.toLowerCase() ?? '';
  const fromL = from.toLowerCase();
  const toL = to.toLowerCase();
  if (pair && fromL === pair && toL !== pair) {
    await syncHolderBalance(provider, tokenAddress, toL, decimals, totalSupply, pair);
  }
  if (pair && toL === pair && fromL !== pair) {
    await syncHolderBalance(provider, tokenAddress, fromL, decimals, totalSupply, pair);
  }
}
