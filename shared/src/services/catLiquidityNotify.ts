import type { Provider } from 'ethers';
import { Contract } from 'ethers';
import { PAIR_ABI } from '../abis.js';
import {
  TG_NOTIFY_LP_CREATED,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID,
  TG_NOTIFY_ENABLED,
} from '../config.js';
import { insertAlert } from '../db/repos/alertRepo.js';
import { hasLpNotifySent, markLpNotifySent, type LpNotifyKey } from '../db/repos/lpNotifyRepo.js';
import { getMonitorToken } from '../monitorTokens.js';
import { fetchTokenMeta } from '../token/erc20.js';
import { quoteSymbol } from '../swap/parse.js';
import { fetchWbnbUsd, swapQuoteUsd } from '../market/price.js';

const CAT_ADDR = '0x0667873e07ffec6509525b4e4cd97409e1fe9424';

async function sendRichLpMessage(text: string): Promise<boolean> {
  if (!TG_NOTIFY_ENABLED || !TG_NOTIFY_LP_CREATED || !TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    return false;
  }
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
  } catch {
    return false;
  }
}

function isCatToken(tokenAddress: string): boolean {
  const t = tokenAddress.toLowerCase();
  if (t === CAT_ADDR) return true;
  const cfg = getMonitorToken(t);
  return cfg?.symbol?.toUpperCase() === 'CAT';
}

async function buildLpMessage(
  provider: Provider,
  input: {
    tokenAddress: string;
    pairAddress: string;
    quoteToken: string;
    tokenAmount: bigint;
    quoteAmount: bigint;
    txHash: string;
    blockNumber: number;
    eventTime: number;
    triggerLabel: string;
  },
): Promise<string> {
  const meta = await fetchTokenMeta(provider, input.tokenAddress);
  const qMeta = await fetchTokenMeta(provider, input.quoteToken);
  const dec = meta?.decimals ?? 18;
  const qDec = qMeta?.decimals ?? 18;
  const tokenHuman = Number(input.tokenAmount) / 10 ** dec;
  const quoteHuman = Number(input.quoteAmount) / 10 ** qDec;
  const wbnbUsd = await fetchWbnbUsd(provider);
  const quoteUsd = swapQuoteUsd(input.quoteAmount, qDec, input.quoteToken, wbnbUsd);
  const price = tokenHuman > 0 ? quoteHuman / tokenHuman : 0;
  const time = new Date(input.eventTime).toLocaleString('zh-CN', { hour12: false });
  const sym = meta?.symbol ?? 'CAT';
  const qSym = quoteSymbol(input.quoteToken);

  return [
    `🚨 ${sym} 创建流动性 · ${input.triggerLabel}`,
    '',
    `Token: ${sym}`,
    `Pair: ${input.pairAddress}`,
    `Quote: ${qSym}`,
    '',
    `CAT 数量: ${tokenHuman.toLocaleString('en-US', { maximumFractionDigits: 4 })}`,
    `${qSym} 数量: ${quoteHuman.toLocaleString('en-US', { maximumFractionDigits: 4 })}`,
    `初始价格: ${price.toFixed(8)} ${qSym}`,
    `初始流动性价值: ~$${quoteUsd.toFixed(2)}`,
    '',
    `Tx: https://bscscan.com/tx/${input.txHash}`,
    `区块: ${input.blockNumber}`,
    `时间: ${time}`,
    '',
    `Pair: https://bscscan.com/address/${input.pairAddress}`,
  ].join('\n');
}

export async function maybeNotifyCatLiquidity(
  provider: Provider,
  input: {
    tokenAddress: string;
    pairAddress: string;
    quoteToken: string;
    tokenAmount: bigint;
    quoteAmount: bigint;
    txHash: string;
    blockNumber: number;
    eventTime: number;
    notifyKey: LpNotifyKey;
    triggerLabel: string;
  },
): Promise<void> {
  if (!isCatToken(input.tokenAddress)) return;
  const token = input.tokenAddress.toLowerCase();
  const pair = input.pairAddress.toLowerCase();
  if (await hasLpNotifySent(token, pair, input.notifyKey)) return;
  if (input.tokenAmount <= 0n && input.quoteAmount <= 0n) return;

  const text = await buildLpMessage(provider, { ...input, triggerLabel: input.triggerLabel });
  markLpNotifySent({
    token_address: token,
    pair_address: pair,
    notify_key: input.notifyKey,
    tx_hash: input.txHash,
    block_number: input.blockNumber,
  });
  const asyncTg = process.env.ALERT_ASYNC !== 'false';
  if (asyncTg) {
    await insertAlert({
      alert_type: `cat_lp_${input.notifyKey}`,
      token_address: token,
      pair_address: pair,
      tx_hash: input.txHash,
      message: text,
      send_status: 'pending',
    });
    return;
  }
  const ok = await sendRichLpMessage(text);
  await insertAlert({
    alert_type: `cat_lp_${input.notifyKey}`,
    token_address: token,
    pair_address: pair,
    tx_hash: input.txHash,
    message: text,
    send_status: ok ? 'success' : 'failed',
  });
  if (!ok) console.error('[Telegram] CAT LP notify failed');
}

export async function checkCatFirstReserves(
  provider: Provider,
  input: {
    tokenAddress: string;
    pairAddress: string;
    quoteToken: string;
    tokenIsToken0: boolean;
    txHash: string;
    blockNumber: number;
    eventTime: number;
  },
): Promise<void> {
  if (!isCatToken(input.tokenAddress)) return;
  const pair = input.pairAddress.toLowerCase();
  const token = input.tokenAddress.toLowerCase();
  if (await hasLpNotifySent(token, pair, 'first_reserves')) return;

  try {
    const c = new Contract(pair, PAIR_ABI, provider);
    const [r0, r1] = await c.getReserves();
    const tokenRes = input.tokenIsToken0 ? BigInt(r0) : BigInt(r1);
    const quoteRes = input.tokenIsToken0 ? BigInt(r1) : BigInt(r0);
    if (tokenRes <= 0n || quoteRes <= 0n) return;
    await maybeNotifyCatLiquidity(provider, {
      tokenAddress: token,
      pairAddress: pair,
      quoteToken: input.quoteToken,
      tokenAmount: tokenRes,
      quoteAmount: quoteRes,
      txHash: input.txHash,
      blockNumber: input.blockNumber,
      eventTime: input.eventTime,
      notifyKey: 'first_reserves',
      triggerLabel: '首次有效储备',
    });
  } catch {
    /* pair not ready */
  }
}
