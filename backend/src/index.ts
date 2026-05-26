import {
  closeDb,
  closePgPools,
  ensureDbReady,
  purgeAlertsOlderThan,
  getTelegramStatus,
  startRpcHealthCheckLoop,
  stopRpcHealthCheckLoop,
} from '@token-monitor/shared';
import { createApp } from './app.js';
import { attachRealtimeServer } from './realtime/hub.js';

const PORT = Number(process.env.PORT ?? 3001);

async function bootstrap(): Promise<void> {
  await ensureDbReady();
  const purgedAlerts = await purgeAlertsOlderThan();
  if (purgedAlerts > 0) {
    console.log(`[API] purged ${purgedAlerts} alert(s) older than retention window`);
  }
  const app = createApp();
  const server = app.listen(PORT, () => {
    attachRealtimeServer(server);
    const tg = getTelegramStatus();
    console.log(`[HTTP] JSON API http://localhost:${PORT}/api/v1`);
    console.log(`[Telegram] ${tg.enabled ? 'enabled' : 'disabled'}`);
    startRpcHealthCheckLoop();
  });

  function shutdown(signal: string) {
    console.log(`[HTTP] ${signal}, closing...`);
    stopRpcHealthCheckLoop();
    server.close(() => {
      void closePgPools().finally(() => {
        closeDb();
        process.exit(0);
      });
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((e) => {
  console.error('[HTTP] fatal:', e);
  process.exit(1);
});
