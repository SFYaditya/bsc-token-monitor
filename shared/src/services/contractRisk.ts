import { Contract, type Provider } from 'ethers';
import { RISK_SCAN_ABI } from '../abis.js';
import { upsertRiskScan } from '../db/repos/riskRepo.js';

const ZERO = '0x0000000000000000000000000000000000000000';

async function tryCall<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

export async function scanTokenRisk(
  provider: Provider,
  tokenAddress: string,
): Promise<Record<string, unknown>> {
  const token = tokenAddress.toLowerCase();
  const c = new Contract(token, RISK_SCAN_ABI, provider);

  let owner = await tryCall(() => c.owner());
  if (owner == null) owner = await tryCall(() => c.getOwner());
  const ownerAddr = owner ? String(owner).toLowerCase() : null;
  const ownerRenounced =
    !ownerAddr || ownerAddr === ZERO || ownerAddr === '0x000000000000000000000000000000000000dead';

  const canMint = c.interface.fragments.some(
    (f) => 'name' in f && f.name === 'mint',
  );

  const hasBlacklist = !!(await tryCall(() => c.isBlacklisted(ZERO)));

  const tradingOpen = await tryCall(() => c.tradingOpen());
  const tradingDisabled = tradingOpen === false;

  const flags: string[] = [];
  if (!ownerRenounced) flags.push('owner_not_renounced');
  if (canMint) flags.push('mint_function');
  if (hasBlacklist) flags.push('blacklist');
  if (tradingDisabled) flags.push('trading_disabled');

  let riskLevel = 'LOW';
  if (flags.length >= 3) riskLevel = 'CRITICAL';
  else if (flags.length >= 2) riskLevel = 'HIGH';
  else if (flags.length >= 1) riskLevel = 'MEDIUM';

  const row = {
    token_address: token,
    owner_address: ownerAddr,
    owner_renounced: ownerRenounced ? 1 : 0,
    can_mint: canMint ? 1 : 0,
    has_blacklist: hasBlacklist ? 1 : 0,
    trading_disabled: tradingDisabled ? 1 : 0,
    risk_level: riskLevel,
    risk_flags: JSON.stringify(flags),
    scanned_at: Date.now(),
  };
  upsertRiskScan(row);
  return row;
}
