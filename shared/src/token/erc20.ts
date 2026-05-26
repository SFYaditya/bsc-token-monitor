import { Contract, type Provider } from 'ethers';
import { ERC20_ABI } from '../abis.js';

export interface TokenMeta {
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
}

export async function fetchTokenMeta(
  provider: Provider,
  address: string,
): Promise<TokenMeta | null> {
  try {
    const c = new Contract(address, ERC20_ABI, provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      c.name(),
      c.symbol(),
      c.decimals(),
      c.totalSupply(),
    ]);
    return {
      name: String(name),
      symbol: String(symbol),
      decimals: Number(decimals),
      totalSupply: (totalSupply as bigint).toString(),
    };
  } catch {
    return null;
  }
}

export async function fetchBalance(
  provider: Provider,
  tokenAddress: string,
  wallet: string,
): Promise<bigint> {
  const c = new Contract(tokenAddress, ERC20_ABI, provider);
  return c.balanceOf(wallet) as Promise<bigint>;
}
