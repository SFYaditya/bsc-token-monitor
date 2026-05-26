import {
  ensureDbReady,
  getTelegramStatus,
  maybePurgeOldAlerts,
  runAlertWorkerBatch,
} from '@token-monitor/shared';

const POLL_MS = Number(process.env.ALERT_WORKER_POLL_MS ?? 3000);

async function main(): Promise<void> {
  await ensureDbReady();
  process.env.ALERT_ASYNC = 'true';
  const tg = getTelegramStatus();
  console.log(`[AlertWorker] started · telegram ${tg.enabled ? 'on' : 'off'}`);
  const purged = await maybePurgeOldAlerts();
  if (purged > 0) console.log(`[AlertWorker] startup purge removed ${purged} old alert(s)`);

  const tick = async () => {
    const r = await runAlertWorkerBatch(40);
    if (r.sent > 0 || r.failed > 0) {
      console.log(`[AlertWorker] sent=${r.sent} failed=${r.failed}`);
    }
  };

  await tick();
  setInterval(() => void tick(), POLL_MS);
}

main().catch((e) => {
  console.error('[AlertWorker] fatal:', e);
  process.exit(1);
});
