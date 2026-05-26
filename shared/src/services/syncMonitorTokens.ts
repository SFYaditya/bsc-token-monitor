import type { Provider } from 'ethers';
import { loadMonitorTokens } from '../monitorTokens.js';
import { ensureSyncStatus, resolveDbResumeBlock } from '../db/repos/syncStatusRepo.js';
import { importToken } from './tokenImport.js';
import { ensureMarketCachePlaceholder } from '../db/repos/marketRepo.js';
import { getContract } from '../db/repos/contractRepo.js';
import { countHolders } from '../db/repos/statRepo.js';
import { repairTokenHolderDatabase } from './holderRepair.js';
import {
  ENABLE_MASTER_CHEF_LISTENER,
  ENABLE_TOKEN_TRANSFER_LISTENER,
} from '../chain/listenerConfig.js';
import type { SyncType } from '../db/repos/syncStatusRepo.js';

export async function syncMonitorTokens(provider: Provider): Promise<string[]> {
  const tokens = loadMonitorTokens();
  const imported: string[] = [];
  for (const cfg of tokens) {
    const dbResume = await resolveDbResumeBlock(cfg.tokenAddress, 'fast_pair_listener');
    const startBlock =
      dbResume > 0 ? dbResume : (cfg.startBlock ?? 0);
    const syncTypes: SyncType[] = ['fast_pair_listener'];
    if (ENABLE_MASTER_CHEF_LISTENER) syncTypes.push('medium_masterchef_listener');
    if (ENABLE_TOKEN_TRANSFER_LISTENER) syncTypes.push('slow_transfer_listener');
    for (const syncType of syncTypes) {
      await ensureSyncStatus({
        token_address: cfg.tokenAddress,
        sync_type: syncType,
        start_block: startBlock,
      });
    }
    try {
      const result = await importToken(provider, {
        contract_address: cfg.tokenAddress,
        pair_address: cfg.pairAddress?.trim() ? cfg.pairAddress : undefined,
      });
      imported.push(result.contract.contract_address);
      await ensureMarketCachePlaceholder(cfg.tokenAddress, cfg.symbol);

      const row = await getContract(cfg.tokenAddress);
      const startupRepair =
        process.env.MONITOR_STARTUP_HOLDER_REPAIR === 'true' ||
        process.env.MONITOR_STARTUP_HOLDER_REPAIR === '1';
      if (row && (startupRepair || (await countHolders(cfg.tokenAddress)) === 0)) {
        try {
          const repair = await repairTokenHolderDatabase(provider, cfg.tokenAddress, {
            forceBackfill:
              startupRepair ||
              !cfg.pairAddress?.trim() ||
              (await countHolders(cfg.tokenAddress)) === 0,
          });
          console.log(
            `[MonitorToken] ${repair.symbol} holders: ${repair.holders_synced} synced, ${repair.profiles_rebuilt} profiles`,
          );
        } catch (holderErr) {
          console.error(
            `[MonitorToken] ${cfg.symbol} holder backfill:`,
            holderErr instanceof Error ? holderErr.message : holderErr,
          );
        }
      }

      console.log(`[MonitorToken] synced ${cfg.symbol} @ ${cfg.tokenAddress}`);
    } catch (err) {
      console.error(
        `[MonitorToken] failed ${cfg.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return imported;
}
