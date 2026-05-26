import {
  TG_NOTIFY_ENABLED,
  TG_NOTIFY_LARGE_TRADE,
  TG_NOTIFY_LIQUIDITY,
  TG_NOTIFY_WHALE,
  TG_NOTIFY_PROJECT,
  TG_NOTIFY_RPC,
  TG_NOTIFY_LISTENER,
} from '../config.js';
import { insertAlert } from '../db/repos/alertRepo.js';
import { sendTelegramText } from '../telegram/notify.js';
import { alertDedupKey, shouldEmitAlert } from './alertDedup.js';
import { publishRealtime } from '../realtime/publish.js';
import { resolveTradeSizeLabel, resolveTradeSizeTier } from '../trade/tradeSizeLabel.js';

export type AlertLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

const TG_BY_TYPE: Record<string, boolean> = {
  large_buy: TG_NOTIFY_LARGE_TRADE,
  large_sell: TG_NOTIFY_LARGE_TRADE,
  liquidity_drop: TG_NOTIFY_LIQUIDITY,
  large_remove_liquidity: TG_NOTIFY_LIQUIDITY,
  whale_buy: TG_NOTIFY_WHALE,
  whale_sell: TG_NOTIFY_WHALE,
  whale_first_buy: TG_NOTIFY_WHALE,
  project_sell: TG_NOTIFY_PROJECT,
  project_transfer: TG_NOTIFY_PROJECT,
  unstake_then_sell: TG_NOTIFY_WHALE,
  listener_stale: TG_NOTIFY_LISTENER,
  listener_lag: TG_NOTIFY_LISTENER,
  listener_token_stale: TG_NOTIFY_LISTENER,
  listener_sync_failed: TG_NOTIFY_LISTENER,
  listener_rpc_failed: TG_NOTIFY_LISTENER,
  rpc_failover: TG_NOTIFY_RPC,
  rpc_manual_switch: TG_NOTIFY_RPC,
  rpc_rate_limited: TG_NOTIFY_RPC,
  rpc_node_removed: TG_NOTIFY_RPC,
  rpc_high_latency: TG_NOTIFY_RPC,
  rpc_unavailable: TG_NOTIFY_RPC,
};

export async function dispatchAlert(input: {
  alert_type: string;
  token_address?: string;
  pair_address?: string;
  tx_hash?: string;
  wallet_address?: string;
  amount_usd?: number;
  level?: AlertLevel;
  message: string;
  telegram?: boolean;
}): Promise<void> {
  const tradeTypes = new Set(['large_buy', 'large_sell', 'whale_buy', 'whale_sell', 'whale_first_buy']);
  const dedupKey =
    input.tx_hash && tradeTypes.has(input.alert_type)
      ? `${input.alert_type}:${input.tx_hash.toLowerCase()}`
      : alertDedupKey(
          input.alert_type,
          input.token_address ?? 'global',
          input.wallet_address,
        );
  const emit = await shouldEmitAlert(dedupKey, tradeTypes.has(input.alert_type) ? 86_400 : 300);
  if (!emit) return;

  const isRpcOps = input.alert_type.startsWith('rpc_');
  if (isRpcOps && !TG_NOTIFY_RPC) {
    console.warn(input.message);
    return;
  }

  const shouldTg =
    input.telegram !== false &&
    TG_NOTIFY_ENABLED &&
    (TG_BY_TYPE[input.alert_type] ?? false);

  const asyncTelegram = process.env.ALERT_ASYNC !== 'false';
  let sendStatus = 'logged';
  if (shouldTg) {
    sendStatus = asyncTelegram ? 'pending' : (await sendTelegramText(input.message) ? 'success' : 'failed');
  }

  await insertAlert({
    alert_type: input.alert_type,
    token_address: input.token_address,
    pair_address: input.pair_address,
    tx_hash: input.tx_hash,
    wallet_address: input.wallet_address,
    amount_usd: input.amount_usd,
    level: input.level ?? 'MEDIUM',
    message: input.message,
    send_status: sendStatus,
  });

  if (shouldTg && asyncTelegram && sendStatus === 'pending') {
    return;
  }

  if (input.token_address) {
    const amountUsd = Number(input.amount_usd ?? 0);
    void publishRealtime({
      type: 'alert_event',
      tokenAddress: input.token_address,
      data: {
        level: input.level ?? 'MEDIUM',
        type: input.alert_type,
        alert_type: input.alert_type,
        title: input.alert_type,
        message: input.message,
        walletAddress: input.wallet_address ?? '',
        wallet_address: input.wallet_address ?? '',
        txHash: input.tx_hash ?? '',
        amountUsd,
        amount_usd: amountUsd,
        tradeSizeTier: amountUsd > 0 ? resolveTradeSizeTier(amountUsd) : undefined,
        tradeSizeLabel: amountUsd > 0 ? resolveTradeSizeLabel(amountUsd) : undefined,
        createdAt: Date.now(),
        created_at: Date.now(),
      },
    });
  }
}
