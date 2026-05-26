import type { Provider } from 'ethers';
import { fetchBalance } from '../token/erc20.js';
import { calcBalancePercent } from '../token/balanceMath.js';
import { deleteHolder, upsertHolder } from '../db/repos/holderRepo.js';
import { updateStatBalance } from '../db/repos/statRepo.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { syncHolderProfileForWallet } from './holderProfileSync.js';
import { setHolderBalanceSource } from './holderBalanceSource.js';

/** 链上 balanceOf 校准并标记 ONCHAIN_CONFIRMED */
export async function confirmHolderBalanceOnchain(
  provider: Provider,
  tokenAddress: string,
  walletAddress: string,
): Promise<{ balance: string; balanceSource: 'ONCHAIN_CONFIRMED' }> {
  const token = tokenAddress.toLowerCase();
  const wallet = walletAddress.toLowerCase();
  const contract = await getContract(token);
  const decimals = contract?.token_decimals ?? 18;
  const supply = contract?.total_supply ?? '0';

  const balance = await fetchBalance(provider, token, wallet);
  const pct = calcBalancePercent(balance, BigInt(supply || '0'));

  if (balance === 0n) {
    deleteHolder(token, wallet);
    updateStatBalance(token, wallet, '0', true);
  } else {
    upsertHolder({
      token_address: token,
      holder_address: wallet,
      balance: balance.toString(),
      balance_percent: pct,
      last_active_time: Date.now(),
    });
    updateStatBalance(token, wallet, balance.toString(), false);
  }

  const market = await getTokenMarket(token);
  await syncHolderProfileForWallet({
    token_address: token,
    wallet_address: wallet,
    price_usd: market?.priceUsd ?? 0,
    liquidity_usd: market?.liquidityUsd ?? 0,
    decimals,
    total_supply: supply,
  });
  await setHolderBalanceSource(token, wallet, 'ONCHAIN_CONFIRMED');

  return { balance: balance.toString(), balanceSource: 'ONCHAIN_CONFIRMED' };
}
