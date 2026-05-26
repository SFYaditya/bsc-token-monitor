import { Contract, type Provider } from 'ethers';
import { ERC20_ABI, PAIR_ABI } from '../abis.js';
import { LP_BURN_ADDRESSES, LP_LOCKER_ADDRESSES } from '../config.js';
import { getPairByToken } from '../db/repos/pairRepo.js';

export async function scanLpLock(
  provider: Provider,
  tokenAddress: string,
): Promise<{ burnedPct: number; lockedPct: number; circulatingPct: number }> {
  const pairRow = await getPairByToken(tokenAddress);
  if (!pairRow?.pair_address) {
    return { burnedPct: 0, lockedPct: 0, circulatingPct: 100 };
  }

  const pairAddr = String(pairRow.pair_address);
  const pair = new Contract(pairAddr, [...PAIR_ABI, ...ERC20_ABI], provider);

  let totalSupply = 0n;
  try {
    totalSupply = await pair.totalSupply();
  } catch {
    return { burnedPct: 0, lockedPct: 0, circulatingPct: 100 };
  }
  if (totalSupply === 0n) {
    return { burnedPct: 0, lockedPct: 0, circulatingPct: 100 };
  }

  let locked = 0n;
  const lockers = [...LP_BURN_ADDRESSES, ...LP_LOCKER_ADDRESSES];
  for (const addr of lockers) {
    try {
      const bal: bigint = await pair.balanceOf(addr);
      locked += bal;
    } catch {
      /* skip */
    }
  }

  const pairReserve = await pair.balanceOf(pairAddr);
  const outside = totalSupply - pairReserve - locked;
  const burnedPct = (Number(locked) / Number(totalSupply)) * 100;
  const inPairPct = (Number(pairReserve) / Number(totalSupply)) * 100;
  const circulatingPct = Math.max(0, (Number(outside) / Number(totalSupply)) * 100);

  return {
    burnedPct: Math.min(100, burnedPct),
    lockedPct: Math.min(100, inPairPct + burnedPct),
    circulatingPct: Math.min(100, circulatingPct),
  };
}
