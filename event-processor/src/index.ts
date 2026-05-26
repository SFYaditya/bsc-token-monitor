import {
  ensureDbReady,
  pickBestHttpRpc,
  getHttpProvider,
  processPendingRawEvents,
  countPendingRawEvents,
  refreshAllMonitorMarkets,
  calibrateAllMonitorHolders,
  ensureRpcManagerReady,
  startRpcHealthCheckLoop,
  tickDataMaintenance,
  MARKET_RESERVES_CALIBRATE_MS,
  HOLDER_CALIBRATE_MS,
} from '@token-monitor/shared';

const POLL_MS = Number(process.env.EVENT_PROCESSOR_POLL_MS ?? 2000);
const MARKET_MS = Number(process.env.MARKET_POLL_MS ?? MARKET_RESERVES_CALIBRATE_MS);
const HOLDER_CAL_MS = Number(process.env.HOLDER_CALIBRATE_POLL_MS ?? HOLDER_CALIBRATE_MS);
const BATCH_LIMIT = Math.min(1000, Number(process.env.RAW_EVENT_BATCH_LIMIT ?? 300));

async function main(): Promise<void> {
  await ensureDbReady();
  console.log('[EventProcessor] started');
  await ensureRpcManagerReady();
  startRpcHealthCheckLoop();
  await pickBestHttpRpc();
  const provider = await getHttpProvider();

  void refreshAllMonitorMarkets(provider).catch(() => undefined);
  setInterval(() => {
    void refreshAllMonitorMarkets(provider).catch(() => undefined);
  }, MARKET_MS);

  setInterval(() => {
    void calibrateAllMonitorHolders(provider).catch(() => undefined);
  }, HOLDER_CAL_MS);

  const tick = async () => {
    let pending = await countPendingRawEvents();
    let rounds = 0;
    while (pending > 0 && rounds < 8) {
      const r = await processPendingRawEvents(provider, BATCH_LIMIT, { pendingBacklog: pending });
      if (r.processed > 0 || r.failed > 0) {
        if (r.fetched >= BATCH_LIMIT) {
          pending = await countPendingRawEvents();
        } else {
          pending = Math.max(0, pending - r.processed);
        }
        console.log(
          `[EventProcessor] batch processed=${r.processed} failed=${r.failed} pending~${pending}`,
        );
      } else {
        break;
      }
      rounds++;
    }
    if (pending > 0) return;
    void tickDataMaintenance(provider).catch((err) => {
      console.error(
        '[EventProcessor] maintenance:',
        err instanceof Error ? err.message : err,
      );
    });
  };

  setInterval(() => void tick(), POLL_MS);
  void tick();
}

main().catch((e) => {
  console.error('[EventProcessor] fatal:', e);
  process.exit(1);
});
