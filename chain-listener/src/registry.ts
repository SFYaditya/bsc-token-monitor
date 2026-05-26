import type { Contract } from 'ethers';

export interface TrackedToken {
  address: string;
  decimals: number;
  totalSupply: string;
  pairAddress?: string;
  transferContract?: Contract;
  pairContract?: Contract;
}

const tokens = new Map<string, TrackedToken>();

export function getTracked(address: string): TrackedToken | undefined {
  return tokens.get(address.toLowerCase());
}

export function setTracked(t: TrackedToken): void {
  tokens.set(t.address.toLowerCase(), t);
}

export function setPairAddress(tokenAddress: string, pairAddress: string): void {
  const t = tokens.get(tokenAddress.toLowerCase());
  if (t) t.pairAddress = pairAddress.toLowerCase();
}
