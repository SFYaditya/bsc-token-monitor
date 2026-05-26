import type { Provider } from 'ethers';
import { loadMonitorTokens } from '../monitorTokens.js';
import { getMeta, setMeta } from '../db/index.js';
import {
  countPendingRawEvents,
  countFailedRawEvents,
  requeueFailedRawEvents,
} from '../db/repos/rawEventRepo.js';
import { syncMarketHolderCount } from '../db/repos/marketRepo.js';
import {
  dedupeLpStakingRecords,
  getLpStakingConfig,
  backfillMissingLpStakingRecords,
  reconcileLpStakingStatFromDb,
  reconcileLpStakedProfilesFromRecords,
  retryLpStakingFailedChunks,
  syncLpStakingWatchWallets,
} from './catLpStaking.js';
import {
  pruneOrphanHolderProfiles,
  reconcileHolderData,
} from './holderReconcile.js';
import { retryLayeredFailedChunks } from '../chain/layeredListeners.js';

const MAINT_MS = Math.max(60_000, Number(process.env.DATA_MAINTENANCE_MS ?? 300_000));
const FULL_MS = Math.max(MAINT_MS, Number(process.env.DATA_MAINTENANCE_FULL_MS ?? 21_600_000));
const REQUEUE_LIMIT = Math.min(500, Number(process.env.DATA_MAINTENANCE_REQUEUE_LIMIT ?? 200));
const BACKLOG_SKIP = Math.max(50, Number(process.env.HOLDER_CALIBRATE_BACKLOG_THRESHOLD ?? 400));

let lastLightAt = 0;
let lastFullAt = 0;

export type DataMaintenanceResult = {
  lp_deduped: number;
  lp_watch_synced: number;
  lp_failed_cleared: number;
  lp_backfilled: number;
  listener_retries: number;
  failed_requeued: number;
  orphan_profiles_pruned: number;
  full_reconcile: boolean;
};

/** 轻量：LP 去重/统计、监控地址质押同步、孤儿 profile、失败 raw 重入队 */
export async function runLightDataMaintenance(
  provider: Provider,
  knownPending?: number,
): Promise<DataMaintenanceResult> {
  const pending = knownPending ?? (await countPendingRawEvents());
  const out: DataMaintenanceResult = {
    lp_deduped: 0,
    lp_watch_synced: 0,
    lp_failed_cleared: 0,
    lp_backfilled: 0,
    listener_retries: 0,
    failed_requeued: 0,
    orphan_profiles_pruned: 0,
    full_reconcile: false,
  };

  if (pending <= BACKLOG_SKIP) {
    const failed = await countFailedRawEvents();
    if (failed > 0) {
      out.failed_requeued = await requeueFailedRawEvents(REQUEUE_LIMIT);
    }
    try {
      out.listener_retries = await retryLayeredFailedChunks(provider);
    } catch {
      /* skip */
    }
    try {
      out.lp_failed_cleared = await retryLpStakingFailedChunks(provider);
    } catch {
      /* skip */
    }
  }

  for (const cfg of loadMonitorTokens()) {
    const token = cfg.tokenAddress.toLowerCase();
    if (getLpStakingConfig(token)) {
      out.lp_deduped += await dedupeLpStakingRecords(token);
      await reconcileLpStakedProfilesFromRecords(token);
      await reconcileLpStakingStatFromDb(token);
      if (pending <= BACKLOG_SKIP && pending === 0) {
        try {
          out.lp_watch_synced += await syncLpStakingWatchWallets(provider, token);
        } catch (err) {
          console.error(
            `[DataMaintenance] LP watch ${token}:`,
            err instanceof Error ? err.message : err,
          );
        }
        try {
          out.lp_backfilled += await backfillMissingLpStakingRecords(token, 6);
        } catch {
          /* skip */
        }
      }
    }
    out.orphan_profiles_pruned += await pruneOrphanHolderProfiles(token);
    await syncMarketHolderCount(token);
  }

  return out;
}

/** 全量：含 holder 对齐（RPC 较重，默认数小时一次） */
export async function runFullDataMaintenance(
  provider: Provider,
): Promise<DataMaintenanceResult> {
  const light = await runLightDataMaintenance(provider);
  for (const cfg of loadMonitorTokens()) {
    try {
      await reconcileHolderData(provider, cfg.tokenAddress);
    } catch (err) {
      console.error(
        `[DataMaintenance] reconcile ${cfg.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  light.full_reconcile = true;
  return light;
}

/** event-processor 空闲时按间隔触发 */
export async function tickDataMaintenance(provider: Provider): Promise<void> {
  const now = Date.now();
  const pending = await countPendingRawEvents();
  if (pending > 0) return;

  if (now - lastLightAt >= MAINT_MS) {
    lastLightAt = now;
    try {
      const r = await runLightDataMaintenance(provider, 0);
      const parts = [
        r.lp_deduped ? `lpDedup=${r.lp_deduped}` : '',
        r.lp_watch_synced ? `lpWatch=${r.lp_watch_synced}` : '',
        r.lp_failed_cleared ? `lpRetry=${r.lp_failed_cleared}` : '',
        r.lp_backfilled ? `lpFill=${r.lp_backfilled}` : '',
        r.listener_retries ? `listenerRetry=${r.listener_retries}` : '',
        r.failed_requeued ? `requeued=${r.failed_requeued}` : '',
        r.orphan_profiles_pruned ? `orphans=${r.orphan_profiles_pruned}` : '',
      ].filter(Boolean);
      if (parts.length) {
        console.log(`[DataMaintenance] light ${parts.join(' ')}`);
      }
    } catch (err) {
      console.error(
        '[DataMaintenance] light failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (now - lastFullAt >= FULL_MS) {
    lastFullAt = now;
    const force = (await getMeta('data_maint_force_full')) === '1';
    if (force) await setMeta('data_maint_force_full', '');
    try {
      const r = await runFullDataMaintenance(provider);
      console.log(
        `[DataMaintenance] full reconcile=${r.full_reconcile} lpDedup=${r.lp_deduped} requeued=${r.failed_requeued}`,
      );
    } catch (err) {
      console.error(
        '[DataMaintenance] full failed:',
        err instanceof Error ? err.message : err,
      );
    }
  }
}
