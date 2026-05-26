import {
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TG_NOTIFY_ENABLED,
  TG_NOTIFY_LP_CREATED,
  TG_NOTIFY_LARGE_TRADE,
  TG_NOTIFY_LIQUIDITY,
  TG_NOTIFY_WHALE,
  TG_NOTIFY_PROJECT,
} from '../config.js';
import { shortenAddress } from '../format.js';
import { insertAlert } from '../db/repos/alertRepo.js';

export function getTelegramStatus(): {
  enabled: boolean;
  lp_notify: boolean;
  large_trade: boolean;
  liquidity: boolean;
  whale: boolean;
  project: boolean;
  has_token: boolean;
  has_chat_id: boolean;
  token_masked: string;
} {
  return {
    enabled: TG_NOTIFY_ENABLED && !!TELEGRAM_BOT_TOKEN && !!TELEGRAM_CHAT_ID,
    lp_notify: TG_NOTIFY_LP_CREATED,
    large_trade: TG_NOTIFY_LARGE_TRADE,
    liquidity: TG_NOTIFY_LIQUIDITY,
    whale: TG_NOTIFY_WHALE,
    project: TG_NOTIFY_PROJECT,
    has_token: !!TELEGRAM_BOT_TOKEN,
    has_chat_id: !!TELEGRAM_CHAT_ID,
    token_masked: TELEGRAM_BOT_TOKEN
      ? `${TELEGRAM_BOT_TOKEN.slice(0, 4)}...${TELEGRAM_BOT_TOKEN.slice(-3)}`
      : '',
  };
}

export async function sendTelegramText(text: string): Promise<boolean> {
  return sendMessage(text);
}

async function sendMessage(text: string): Promise<boolean> {
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
          disable_web_page_preview: true,
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function sendTestNotification(): Promise<boolean> {
  const ok = await sendMessage('Telegram 通知测试成功。');
  await insertAlert({
    alert_type: 'test',
    message: 'Telegram 通知测试成功。',
    send_status: ok ? 'success' : 'failed',
  });
  return ok;
}

export async function notifyLpCreated(input: {
  tokenAddress: string;
  pairAddress: string;
  quoteSymbol: string;
  txHash: string;
  eventTime: number;
}): Promise<void> {
  if (!TG_NOTIFY_LP_CREATED) return;
  const time = new Date(input.eventTime).toLocaleString('zh-CN', { hour12: false });
  const text = [
    '🚨 LP 已创建',
    '',
    `Token: ${shortenAddress(input.tokenAddress)}`,
    `Pair: ${shortenAddress(input.pairAddress)}`,
    `Quote: ${input.quoteSymbol}`,
    '',
    'Tx:',
    `https://bscscan.com/tx/${input.txHash}`,
    '',
    `Time: ${time}`,
    '',
    '交易监控已启动。',
  ].join('\n');

  const ok = await sendMessage(text);
  await insertAlert({
    alert_type: 'lp_created',
    token_address: input.tokenAddress,
    pair_address: input.pairAddress,
    tx_hash: input.txHash,
    message: text,
    send_status: ok ? 'success' : 'failed',
  });
  if (!ok) console.error('[Telegram] LP notify send failed');
}
