import { sendTelegramText } from '../telegram/notify.js';
import {
  listAlertsPendingTelegram,
  purgeAlertsOlderThan,
  updateAlertSendStatus,
} from '../db/repos/alertRepo.js';
import { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TG_NOTIFY_ENABLED, TG_NOTIFY_LISTENER } from '../config.js';

async function sendRichCatMessage(text: string): Promise<boolean> {
  if (!TG_NOTIFY_ENABLED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          text,
          disable_web_page_preview: false,
        }),
      },
    );
    return res.ok;
  } catch (e) {
    console.error('[AlertWorker] telegram:', e instanceof Error ? e.message : e);
    return false;
  }
}

let lastAlertPurgeAt = 0;
const ALERT_PURGE_INTERVAL_MS = Math.max(
  60_000,
  Number(process.env.ALERT_PURGE_INTERVAL_MS ?? 5 * 60_000),
);

export async function maybePurgeOldAlerts(): Promise<number> {
  const now = Date.now();
  if (now - lastAlertPurgeAt < ALERT_PURGE_INTERVAL_MS) return 0;
  lastAlertPurgeAt = now;
  const n = await purgeAlertsOlderThan();
  if (n > 0) {
    console.log(`[AlertWorker] purged ${n} alert(s) older than retention window`);
  }
  return n;
}

export async function runAlertWorkerBatch(limit = 30): Promise<{ sent: number; failed: number }> {
  await maybePurgeOldAlerts();
  const pending = await listAlertsPendingTelegram(limit);
  let sent = 0;
  let failed = 0;
  for (const row of pending) {
    const alertType = String(row.alert_type ?? '');
    if (alertType.startsWith('listener_') && !TG_NOTIFY_LISTENER) {
      updateAlertSendStatus(Number(row.id), 'skipped', 'listener notify disabled');
      continue;
    }
    const msg = String(row.message ?? '');
    const isCatLp = alertType.startsWith('cat_lp_');
    const ok = isCatLp ? await sendRichCatMessage(msg) : await sendTelegramText(msg);
    if (ok) {
      updateAlertSendStatus(Number(row.id), 'success', null);
      sent++;
    } else {
      updateAlertSendStatus(
        Number(row.id),
        'failed',
        'Telegram API request failed',
      );
      failed++;
    }
  }
  return { sent, failed };
}
