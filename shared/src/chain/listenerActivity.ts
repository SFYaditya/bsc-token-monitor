import { getMeta, setMeta } from '../db/index.js';
import {
  FAST_PAIR_QUIET_MS,
  MEDIUM_MC_QUIET_MS,
  SLOW_TRANSFER_QUIET_MS,
} from './listenerConfig.js';

function key(kind: string, address: string): string {
  return `listener_activity:${kind}:${address.toLowerCase()}`;
}

export async function touchPairSwapActivity(pairAddress: string): Promise<void> {
  await setMeta(key('pair_swap', pairAddress), String(Date.now()));
}

export async function touchStakingActivity(stakingAddress: string): Promise<void> {
  await setMeta(key('staking', stakingAddress), String(Date.now()));
}

export async function touchTransferActivity(tokenAddress: string): Promise<void> {
  await setMeta(key('transfer', tokenAddress), String(Date.now()));
}

async function lastActivityMs(kind: string, address: string): Promise<number> {
  const raw = await getMeta(key(kind, address));
  return raw ? Number(raw) : 0;
}

export async function isPairRecentlyActive(pairAddress: string): Promise<boolean> {
  const last = await lastActivityMs('pair_swap', pairAddress);
  return last > 0 && Date.now() - last < FAST_PAIR_QUIET_MS;
}

export async function isStakingRecentlyActive(stakingAddress: string): Promise<boolean> {
  const last = await lastActivityMs('staking', stakingAddress);
  return last > 0 && Date.now() - last < MEDIUM_MC_QUIET_MS;
}

export async function isTransferRecentlyActive(tokenAddress: string): Promise<boolean> {
  const last = await lastActivityMs('transfer', tokenAddress);
  return last > 0 && Date.now() - last < SLOW_TRANSFER_QUIET_MS;
}
