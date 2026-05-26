import type { Provider } from 'ethers';
import { dbAll } from '../db/pg/query.js';
import { CHAIN_ID } from '../config.js';
import { getHolderBalance } from '../db/repos/holderRepo.js';
import { confirmHolderBalanceOnchain } from './holderOnchainBalance.js';
import { loadMonitorTokens } from '../monitorTokens.js';
import { HOLDER_CALIBRATE_MS } from '../chain/listenerConfig.js';
import { calibrateTokenLpBalances, getLpStakingConfig } from './catLpStaking.js';
import { countPendingRawEvents } from '../db/repos/rawEventRepo.js';

const calibrateLastAt = new Map<string, number>();

export async function markHolderForCalibration(
  tokenAddress: string,
  wallet: string,
): Promise<void> {
  const token = tokenAddress.toLowerCase();
  const w = wallet.toLowerCase();
  const key = `holder_cal:${token}`;
  const { getMeta, setMeta } = await import('../db/index.js');
  const raw = (await getMeta(key)) ?? '';
  const set = new Set(raw.split(',').filter(Boolean));
  set.add(w);
  const list = [...set].slice(-200);
  await setMeta(key, list.join(','));
}

async function pendingCalibrationWallets(token: string): Promise<string[]> {
  const { getMeta } = await import('../db/index.js');
  const raw = (await getMeta(`holder_cal:${token}`)) ?? '';
  return raw.split(',').filter(Boolean);
}

async function listActiveWallets(token: string, sinceMs: number): Promise<string[]> {
  const cutoff = Date.now() - sinceMs;
  const rows = await dbAll<{ wallet_address: string }>(
    `SELECT wallet_address FROM token_address_stat
     WHERE chain_id = ? AND token_address = ? AND last_trade_time >= ?
     ORDER BY last_trade_time DESC LIMIT 80`,
    [CHAIN_ID, token, cutoff],
  );
  return rows.map((r) => String(r.wallet_address).toLowerCase());
}

async function listTopHolders(token: string, limit: number): Promise<string[]> {
  const rows = await dbAll<{ holder_address: string }>(
    `SELECT holder_address FROM token_holder
     WHERE chain_id = ? AND token_address = ?
     ORDER BY balance_percent DESC NULLS LAST LIMIT ?`,
    [CHAIN_ID, token, limit],
  );
  return rows.map((r) => String(r.holder_address).toLowerCase());
}

/** 对活跃地址、Top holders、待校准队列执行 balanceOf */
export async function calibrateTokenHolders(
  provider: Provider,
  tokenAddress: string,
): Promise<number> {
  const token = tokenAddress.toLowerCase();
  const now = Date.now();
  const last = calibrateLastAt.get(token) ?? 0;
  if (now - last < HOLDER_CALIBRATE_MS) return 0;
  calibrateLastAt.set(token, now);

  const wallets = new Set<string>();
  for (const w of await pendingCalibrationWallets(token)) wallets.add(w);
  for (const w of await listActiveWallets(token, 10 * 60_000)) wallets.add(w);
  for (const w of await listTopHolders(token, 40)) wallets.add(w);

  let n = 0;
  for (const w of wallets) {
    if (!w) continue;
    await confirmHolderBalanceOnchain(provider, token, w);
    n++;
  }

  if (n > 0) {
    const { setMeta } = await import('../db/index.js');
    await setMeta(`holder_cal:${token}`, '');
  }

  if (getLpStakingConfig(token)) {
    try {
      const lpN = await calibrateTokenLpBalances(provider, token);
      if (lpN > 0) n += lpN;
    } catch (err) {
      console.error(
        `[HolderCalibrate] LP ${token}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return n;
}

export async function calibrateAllMonitorHolders(provider: Provider): Promise<void> {
  const pending = await countPendingRawEvents();
  if (pending > 0) return;

  for (const cfg of loadMonitorTokens()) {
    try {
      const n = await calibrateTokenHolders(provider, cfg.tokenAddress);
      if (n > 0) {
        console.log(`[HolderCalibrate] ${cfg.symbol} refreshed ${n} wallets`);
      }
    } catch (err) {
      console.error(
        `[HolderCalibrate] ${cfg.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

export async function getHolderBalanceCached(
  token: string,
  wallet: string,
): Promise<string | null> {
  return getHolderBalance(token, wallet);
}
