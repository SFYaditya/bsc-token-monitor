import type { Provider } from 'ethers';
import { fetchBalance } from '../token/erc20.js';

/** Swap 成交后钱包持有的 quote 代币余额（链上 balanceOf） */
export async function fetchQuoteBalanceAfter(
  provider: Provider,
  quoteToken: string,
  wallet: string,
): Promise<string | null> {
  const quote = String(quoteToken ?? '').trim().toLowerCase();
  const w = String(wallet ?? '').trim().toLowerCase();
  if (!quote || !w) return null;
  try {
    const bal = await fetchBalance(provider, quote, w);
    return bal.toString();
  } catch {
    return null;
  }
}
