import {
  CHAIN_ID,
  MONITOR_WALLET,
  ensureDbReady,
  getMeta,
  setMeta,
  pickBestHttpRpc,
  refreshRpcStatus,
  loadMonitorTokens,
  syncMonitorTokens,
  getWssProvider,
  getHttpProvider,
  drainImportQueue,
} from '@token-monitor/shared';
import {
  bootstrapLayeredListeners,
  runAllLayeredListeners,
} from '@token-monitor/shared';
import {
  updateListenerHeartbeat,
  runListenerHealthCheck,
  recordRpcSuccess,
  recordRpcFailure,
  logSyncStatusSummary,
} from '@token-monitor/shared';
import {
  LISTENER_POLL_MS,
  LISTENER_HEARTBEAT_MS,
  LISTENER_HEALTH_CHECK_MS,
  LISTENER_MAX_SCANS_PER_POLL,
  LISTENER_POLL_FAST_MS,
  SYNC_BURST_POLL_MAX_MS,
  SYNC_CATCHUP_LAG_BLOCKS,
  SYNC_CATCHUP_MAX_SCANS_PER_POLL,
  SYNC_DEEP_CATCHUP_MAX_SCANS_PER_POLL,
  SYNC_DEEP_LAG_BLOCKS,
  SYNC_DEEP_LAG_SLOW_MAX_SCANS,
  SYNC_TARGET_MAX_LAG_BLOCKS,
  startRpcHealthCheckLoop,
  ensureRpcManagerReady,
  maxTokenLagBlocks,
  touchAllMonitorSyncHeartbeats,
} from '@token-monitor/shared';
import { loadExistingTokens, startFactoryListener, subscribeToken } from './tokenTracker.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function pollCatchUp(): Promise<void> {
  const http = await getHttpProvider();
  const burstStart = Date.now();
  try {
    let rounds = 0;
    while (true) {
      await touchAllMonitorSyncHeartbeats();
      const lag = await maxTokenLagBlocks();
      const deepLag = lag > SYNC_DEEP_LAG_BLOCKS;
      const catchingUp = lag > SYNC_TARGET_MAX_LAG_BLOCKS;
      const maxScans = catchingUp
        ? deepLag
          ? SYNC_DEEP_CATCHUP_MAX_SCANS_PER_POLL
          : SYNC_CATCHUP_MAX_SCANS_PER_POLL
        : LISTENER_MAX_SCANS_PER_POLL;
      const r = await runAllLayeredListeners(http, {
        label: deepLag ? 'Poll/burst' : 'Poll',
        maxScansPerTask: maxScans,
        slowMaxScansPerTask: deepLag ? SYNC_DEEP_LAG_SLOW_MAX_SCANS : maxScans,
      });
      rounds++;
      const lagAfter = await maxTokenLagBlocks();
      if (r.allIdle || lagAfter <= SYNC_TARGET_MAX_LAG_BLOCKS) break;
      if (Date.now() - burstStart >= SYNC_BURST_POLL_MAX_MS) break;
      if (!catchingUp) break;
      await sleep(deepLag ? 80 : 200);
    }
    if (rounds > 1) {
      const lagEnd = await maxTokenLagBlocks();
      console.log(`[ChainListener] burst catch-up rounds=${rounds} lag~${lagEnd}`);
    }
    const st = await refreshRpcStatus();
    recordRpcSuccess();
    updateListenerHeartbeat({
      latest_block: st.latest_block,
      status: 'RUNNING',
    });
  } catch (err) {
    recordRpcFailure(err);
    console.error('[ChainListener] poll:', err instanceof Error ? err.message : err);
    updateListenerHeartbeat({
      status: 'DEGRADED',
      error_message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  await ensureDbReady();
  console.log('[ChainListener] started (fast_pair / medium_mc / slow_transfer)');
  console.log(`Chain ID: ${CHAIN_ID}`);
  console.log(`Monitor wallet: ${MONITOR_WALLET}`);

  await ensureRpcManagerReady();
  startRpcHealthCheckLoop();
  await pickBestHttpRpc();
  const status = await refreshRpcStatus();
  console.log(`RPC connected · latency ${status.latency}ms · head ${status.latest_block}`);
    void updateListenerHeartbeat({ latest_block: status.latest_block });

  const httpProvider = await getHttpProvider();
  const monitorTokens = loadMonitorTokens();
  if (monitorTokens.length) {
    console.log(`Tokens: ${monitorTokens.map((t) => t.symbol).join(', ')}`);
    await syncMonitorTokens(httpProvider);
  }

  await loadExistingTokens(httpProvider);
  for (const addr of await drainImportQueue()) {
    try {
      await subscribeToken(httpProvider, addr);
    } catch (err) {
      console.error(`[Import] subscribe ${addr}:`, err instanceof Error ? err.message : err);
    }
  }

  let wssProvider: Awaited<ReturnType<typeof getWssProvider>> | null = null;
  try {
    wssProvider = await getWssProvider();
    startFactoryListener(wssProvider);
    wssProvider.on('block', async (blockNumber: number) => {
      try {
        const block = await wssProvider!.getBlock(blockNumber, true);
        if (block?.prefetchedTransactions) {
          const { handleDeployment } = await import('./tokenTracker.js');
          for (const tx of block.prefetchedTransactions) {
            if (tx.to != null) continue;
            const receipt = await wssProvider!.getTransactionReceipt(tx.hash);
            if (!receipt?.contractAddress) continue;
            await handleDeployment(wssProvider!, tx, receipt);
          }
        }
        await setMeta('last_scanned_block', String(blockNumber));
        void setMeta('last_seen_block', String(blockNumber));
      } catch (err) {
        recordRpcFailure(err);
        console.error('[ChainListener] block:', err instanceof Error ? err.message : err);
      }
    });
    console.log('[ChainListener] WSS block subscription active (deploy scan; contract events → raw_events)');
  } catch (err) {
    console.warn(
      '[ChainListener] WSS unavailable, relying on HTTP poll only:',
      err instanceof Error ? err.message : err,
    );
  }

  await bootstrapLayeredListeners(httpProvider).catch((err) => {
    console.error('[ChainListener] bootstrap sync:', err instanceof Error ? err.message : err);
  });
  await logSyncStatusSummary();

  const runPollLoop = () => {
    void (async () => {
      await pollCatchUp();
      const lag = await maxTokenLagBlocks();
      const delay =
        lag > SYNC_TARGET_MAX_LAG_BLOCKS ? LISTENER_POLL_FAST_MS : LISTENER_POLL_MS;
      setTimeout(runPollLoop, delay);
    })();
  };
  runPollLoop();

  setInterval(() => {
    void refreshRpcStatus()
      .then(async (st) => {
        recordRpcSuccess();
        void updateListenerHeartbeat({ latest_block: st.latest_block });
        const last = (await getMeta('last_scanned_block')) ?? '-';
        console.log(`[ChainListener] heartbeat · head ${st.latest_block} · scanned ${last}`);
      })
      .catch((err) => {
        recordRpcFailure(err);
      });
  }, LISTENER_HEARTBEAT_MS);

  setInterval(() => {
    void runListenerHealthCheck();
  }, LISTENER_HEALTH_CHECK_MS);

  setInterval(async () => {
    await loadExistingTokens(httpProvider);
    for (const addr of await drainImportQueue()) {
      try {
        await subscribeToken(httpProvider, addr);
      } catch {
        /* ignore */
      }
    }
  }, LISTENER_HEARTBEAT_MS * 3);
}

main().catch((e) => {
  console.error('[ChainListener] fatal:', e);
  process.exit(1);
});
