import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
dotenv.config({ path: path.join(ROOT, '.env') });

export const CHAIN_ID = Number(process.env.CHAIN_ID ?? 56);
export const CHAIN_NAME = 'BSC';

export const DATA_DIR = path.resolve(
  ROOT,
  process.env.DATA_DIR?.trim() || path.dirname(process.env.DATABASE_PATH ?? './data') || './data',
);
const dbFile =
  process.env.DB_FILE?.trim() ||
  path.basename(process.env.DATABASE_PATH ?? 'token-monitor.db');
export const DB_PATH = path.join(DATA_DIR, dbFile);

export const MONITOR_WALLET = (
  process.env.MONITOR_WALLET ??
  '0xe45C0199A65f55CE2EfbB865025A52b3C75440BC'
).toLowerCase();

export const PANCAKE_FACTORY = (
  process.env.PANCAKE_FACTORY_ADDRESS ??
  '0xCA143CE32fE78F1f7019D1D19261165e12C7ce1c'
).toLowerCase();
export const PANCAKE_ROUTER = (
  process.env.PANCAKE_ROUTER_ADDRESS ??
  '0x10ED43C718714eb63d5aA57B78B54704E256024E'
).toLowerCase();

export const WBNB = '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c';
export const USDT = '0x55d398326f99059ff775485246999027b3197955';
export const BUSD = '0xe9e7cea3dedca5984780bafc599bd69add087d56';
export const QUOTE_TOKENS = [WBNB, USDT, BUSD];

export const BNB_PRICE_USD = Number(process.env.BNB_PRICE_USD ?? 600);

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
export const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
export const TG_NOTIFY_ENABLED = process.env.TG_NOTIFY_ENABLED !== 'false';
export const TG_NOTIFY_LP_CREATED = process.env.TG_NOTIFY_LP_CREATED !== 'false';
export const TG_NOTIFY_LARGE_TRADE = process.env.TG_NOTIFY_LARGE_TRADE !== 'false';
export const TG_NOTIFY_LIQUIDITY = process.env.TG_NOTIFY_LIQUIDITY !== 'false';
export const TG_NOTIFY_WHALE = process.env.TG_NOTIFY_WHALE !== 'false';
export const TG_NOTIFY_PROJECT = process.env.TG_NOTIFY_PROJECT !== 'false';
/** RPC 切换/限流/移除等运维类 Telegram，默认关闭避免刷屏 */
export const TG_NOTIFY_RPC = process.env.TG_NOTIFY_RPC === 'true';
/** 链监听 lag/stale 类 Telegram，默认关闭避免刷屏 */
export const TG_NOTIFY_LISTENER = process.env.TG_NOTIFY_LISTENER === 'true';

export const LIQUIDITY_DROP_PCT = Number(process.env.LIQUIDITY_DROP_PCT ?? 20);

export const LP_BURN_ADDRESSES = (
  process.env.LP_BURN_ADDRESSES ??
  '0x000000000000000000000000000000000000dead,0x0000000000000000000000000000000000000001'
)
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

export const LP_LOCKER_ADDRESSES = (
  process.env.LP_LOCKER_ADDRESSES ??
  '0x407993575cba322225f8629d79911ccac513337'
)
  .split(',')
  .map((a) => a.trim().toLowerCase())
  .filter(Boolean);

export const AUTH_PASSWORD = process.env.AUTH_PASSWORD ?? '';

export const WHALE_RULE = {
  minSingleTradeUsd: Number(process.env.WHALE_MIN_TRADE_USD ?? 1000),
  minHoldingUsd: Number(process.env.WHALE_MIN_HOLDING_USD ?? 5000),
  minHoldingPercent: Number(process.env.WHALE_MIN_HOLDING_PCT ?? 0.5),
};

export const ALERT_LARGE_TRADE_USD = Number(process.env.ALERT_LARGE_TRADE_USD ?? 1000);

export function collectHttpsRpcUrls(): string[] {
  const fromList = (process.env.BSC_RPC_URLS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const legacy = [
    process.env.BSC_RPC_URL,
    process.env.HTTPS_PRIMARY,
    process.env.BSC_RPC_BACKUP_1,
    process.env.BSC_RPC_BACKUP_2,
    process.env.BSC_RPC_BACKUP_3,
    process.env.BSC_RPC_BACKUP_4,
    process.env.HTTPS_BACKUP,
  ].filter((u): u is string => !!u?.trim());
  return [...new Set([...fromList, ...legacy])];
}

export function collectWssRpcUrls(): string[] {
  const urls = [process.env.WSS_PRIMARY, process.env.WSS_BACKUP].filter(
    (u): u is string => !!u?.trim(),
  );
  return [...new Set(urls)];
}
