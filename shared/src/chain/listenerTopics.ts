import { Interface } from 'ethers';
import { ERC20_ABI, MASTERCHEF_EVENT_ABI, PAIR_ABI, STAKING_EVENT_ABI } from '../abis.js';

const TRANSFER_IFACE = new Interface(ERC20_ABI);
const PAIR_IFACE = new Interface(PAIR_ABI);
const MC_IFACE = new Interface([...MASTERCHEF_EVENT_ABI, ...STAKING_EVENT_ABI]);

export const TRANSFER_TOPIC = TRANSFER_IFACE.getEvent('Transfer')!.topicHash;
export const SWAP_TOPIC = PAIR_IFACE.getEvent('Swap')!.topicHash;
export const SYNC_TOPIC = PAIR_IFACE.getEvent('Sync')!.topicHash;
export const MINT_TOPIC = PAIR_IFACE.getEvent('Mint')!.topicHash;
export const BURN_TOPIC = PAIR_IFACE.getEvent('Burn')!.topicHash;

/** Pair Fast Listener：Swap / Sync / Mint / Burn + LP Transfer（质押/转 LP） */
export const FAST_PAIR_TOPICS: string[] = [
  SWAP_TOPIC,
  SYNC_TOPIC,
  MINT_TOPIC,
  BURN_TOPIC,
  TRANSFER_TOPIC,
];

/** Token / LP Slow Listener：仅 Transfer */
export const SLOW_TRANSFER_TOPICS: string[] = [TRANSFER_TOPIC];

function mcTopic(name: string): string | null {
  try {
    const ev = MC_IFACE.getEvent(name);
    return ev?.topicHash ?? null;
  } catch {
    return null;
  }
}

const MC_DEPOSIT = mcTopic('Deposit');
const MC_WITHDRAW = mcTopic('Withdraw');
const MC_EMERGENCY = mcTopic('EmergencyWithdraw');
const MC_HARVEST = mcTopic('Harvest');
const MC_STAKED = mcTopic('Staked');
const MC_WITHDRAWN = mcTopic('Withdrawn');
const MC_REWARD = mcTopic('RewardPaid');

/** MasterChef Medium Listener */
export const MEDIUM_MASTERCHEF_TOPICS: string[] = [
  MC_DEPOSIT,
  MC_WITHDRAW,
  MC_EMERGENCY,
  MC_HARVEST,
  MC_STAKED,
  MC_WITHDRAWN,
  MC_REWARD,
].filter((t): t is string => !!t);

export { PAIR_IFACE, TRANSFER_IFACE, MC_IFACE };
