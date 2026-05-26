import type { Provider } from 'ethers';
import { dbGet } from '../db/pg/query.js';
import { insertTokenTransaction } from '../db/repos/transactionRepo.js';
import { resolveAddressType, getCachedAddressType } from './addressRegistry.js';
import { syncHolderProfileForWallet } from './holderProfileSync.js';
import { HOLDER_SKIP_BALANCEOF_ON_EVENT } from '../chain/listenerConfig.js';
import { CHAIN_ID } from '../config.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { getContract } from '../db/repos/contractRepo.js';
import { getHolderBalance } from '../db/repos/holderRepo.js';
import type { EventType } from '../lifecycle.js';
import { tradePriceUsdFromEvent } from '../market/tradePrice.js';
import { resolveTradeSizeLabel, resolveTradeSizeTier } from '../trade/tradeSizeLabel.js';

function sideForEvent(eventType: EventType): string | null {
  if (eventType === 'buy') return 'BUY';
  if (eventType === 'sell') return 'SELL';
  if (eventType === 'transfer') return 'TRANSFER';
  if (eventType === 'stake') return 'STAKE';
  if (eventType === 'unstake') return 'UNSTAKE';
  if (eventType === 'add_liquidity') return 'ADD_LIQ';
  if (eventType === 'remove_liquidity') return 'REMOVE_LIQ';
  return null;
}

async function getStatSnapshot(
  token: string,
  wallet: string,
): Promise<Record<string, unknown> | undefined> {
  return dbGet(
    `SELECT * FROM token_address_stat WHERE chain_id = ? AND token_address = ? AND wallet_address = ?`,
    [CHAIN_ID, token, wallet],
  );
}

export async function finalizeChainTransaction(
  provider: Provider,
  input: {
    token_address: string;
    wallet_address: string;
    event_type: EventType;
    tx_hash: string;
    log_index: number;
    block_number: number;
    block_time: number;
    token_amount?: string;
    quote_amount?: string;
    amount_usd?: number;
    price?: number;
    balance_after?: string;
    quote_balance_after?: string;
    staking_balance_after?: string;
    from_address?: string;
    to_address?: string;
    pair_address?: string;
    contract_address?: string;
    pushRealtime?: boolean;
    stat?: Record<string, unknown>;
    market?: Awaited<ReturnType<typeof getTokenMarket>>;
    contract?: Awaited<ReturnType<typeof getContract>>;
  },
): Promise<{ inserted: boolean; walletAddress: string }> {
  const token = input.token_address.toLowerCase();
  const wallet = input.wallet_address.toLowerCase();
  const addrInfo = await resolveAddressType(provider, wallet);
  const stat = input.stat ?? (await getStatSnapshot(token, wallet));
  const stakingBal = String(stat?.staking_balance ?? input.staking_balance_after ?? '0');
  const balanceAfter =
    input.balance_after ?? (await getHolderBalance(token, wallet)) ?? '0';

  const inserted = await insertTokenTransaction({
    token_address: token,
    wallet_address: wallet,
    address_type: addrInfo.address_type,
    is_contract: addrInfo.is_contract,
    tx_hash: input.tx_hash,
    log_index: input.log_index,
    block_number: input.block_number,
    block_time: input.block_time,
    trade_type: input.event_type,
    side: sideForEvent(input.event_type),
    token_amount: input.token_amount,
    quote_amount: input.quote_amount,
    amount_usd: input.amount_usd,
    price: input.price,
    balance_after: balanceAfter,
    quote_balance_after: input.quote_balance_after,
    staking_balance_after: stakingBal,
    buy_count_after: Number(stat?.buy_count ?? 0),
    sell_count_after: Number(stat?.sell_count ?? 0),
    from_address: input.from_address,
    to_address: input.to_address,
    pair_address: input.pair_address,
    contract_address: input.contract_address ?? token,
  });

  const market = input.market ?? (await getTokenMarket(token));
  const contract = input.contract ?? (await getContract(token));
  await syncHolderProfileForWallet({
    token_address: token,
    wallet_address: wallet,
    price_usd: market?.priceUsd ?? 0,
    liquidity_usd: market?.liquidityUsd ?? 0,
    decimals: contract?.token_decimals ?? 18,
    total_supply: contract?.total_supply ?? '0',
    address_type: addrInfo.address_type,
    is_contract: addrInfo.is_contract,
    pushRealtime: input.pushRealtime,
    balance_source: HOLDER_SKIP_BALANCEOF_ON_EVENT ? 'EVENT_ESTIMATED' : undefined,
    last_balance_checked_at: HOLDER_SKIP_BALANCEOF_ON_EVENT ? Date.now() : null,
  });

  return { inserted, walletAddress: wallet };
}

export async function enrichRealtimeTradePayload(
  token: string,
  wallet: string,
  base: Record<string, unknown>,
  opts?: {
    stat?: Record<string, unknown>;
    contract?: Awaited<ReturnType<typeof getContract>>;
  },
): Promise<Record<string, unknown>> {
  const stat = opts?.stat ?? (await getStatSnapshot(token, wallet));
  const addr = await getCachedAddressType(wallet);
  const contract = opts?.contract ?? (await getContract(token));
  const dec = contract?.token_decimals ?? 18;
  const priceUsd = tradePriceUsdFromEvent(
    Number(base.amountUsd ?? 0),
    String(base.tokenAmount ?? '0'),
    dec,
    Number(base.price ?? 0),
  );
  const balanceAfter =
    base.balanceAfter != null
      ? String(base.balanceAfter)
      : ((await getHolderBalance(token, wallet)) ?? '0');
  const amountUsd = Number(base.amountUsd ?? 0);
  return {
    ...base,
    walletAddress: wallet,
    addressType: addr.address_type,
    isContract: addr.is_contract === 1,
    buyCountAfter: Number(stat?.buy_count ?? 0),
    sellCountAfter: Number(stat?.sell_count ?? 0),
    balanceAfter,
    quoteBalanceAfter:
      base.quoteBalanceAfter != null
        ? String(base.quoteBalanceAfter)
        : base.quote_balance_after != null
          ? String(base.quote_balance_after)
          : null,
    blockNumber: base.blockNumber,
    blockTime: base.blockTime,
    priceUsd,
    tradeSizeTier: resolveTradeSizeTier(amountUsd),
    tradeSizeLabel: resolveTradeSizeLabel(amountUsd),
  };
}
