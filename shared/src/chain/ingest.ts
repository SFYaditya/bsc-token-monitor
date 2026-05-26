import type { Provider } from 'ethers';
import { PANCAKE_FACTORY } from '../config.js';
import { insertRawEvent } from '../db/repos/rawEventRepo.js';

export type IngestPairCtx = {
  pairAddress: string;
  tokenAddress: string;
  quoteToken: string;
  quoteSymbol?: string;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
};

/**
 * Chain Listener：仅有链上目标 Token 事件时才写入 raw_events。
 * 业务表（token_transactions、holder_profiles 等）由 event-processor 消费 raw_events 后写入。
 * 空区块范围不会调用本模块，sync_status 游标仍会在扫描成功后推进。
 */
export async function ingestTransferLog(
  _provider: Provider,
  input: {
    tokenAddress: string;
    decimals: number;
    totalSupply: string;
    from: string;
    to: string;
    value: bigint;
    txHash: string;
    logIndex: number;
    blockNumber: number;
    eventTime: number;
    pairAddress?: string;
    topics?: string[];
    data?: string;
  },
): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  return await insertRawEvent({
    token_address: token,
    contract_address: token,
    event_name: 'Transfer',
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    block_time: input.eventTime,
    from_address: input.from.toLowerCase(),
    to_address: input.to.toLowerCase(),
    topics: input.topics,
    data: input.data,
    decoded_data: {
      decimals: input.decimals,
      totalSupply: input.totalSupply,
      from: input.from.toLowerCase(),
      to: input.to.toLowerCase(),
      value: input.value.toString(),
      pairAddress: input.pairAddress?.toLowerCase() ?? null,
    },
  });
}

export async function ingestSwapLog(input: {
  tokenAddress: string;
  decimals: number;
  totalSupply: string;
  pairAddress: string;
  pairCtx: IngestPairCtx;
  tradeType: 'buy' | 'sell';
  trader: string;
  tokenAmount: bigint;
  quoteAmount: bigint;
  price: number;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventTime: number;
  topics?: string[];
  data?: string;
}): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  return insertRawEvent({
    token_address: token,
    contract_address: input.pairAddress.toLowerCase(),
    event_name: 'Swap',
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    block_time: input.eventTime,
    from_address: input.trader.toLowerCase(),
    topics: input.topics,
    data: input.data,
    decoded_data: {
      decimals: input.decimals,
      totalSupply: input.totalSupply,
      pairAddress: input.pairAddress.toLowerCase(),
      pairCtx: input.pairCtx,
      tradeType: input.tradeType,
      trader: input.trader.toLowerCase(),
      tokenAmount: input.tokenAmount.toString(),
      quoteAmount: input.quoteAmount.toString(),
      price: input.price,
    },
  });
}

export async function ingestLiquidityLog(input: {
  tokenAddress: string;
  eventName: 'Mint' | 'Burn';
  eventType: 'add_liquidity' | 'remove_liquidity';
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventTime: number;
  pairAddress: string;
  trader: string;
  tokenAmount: string;
  quoteAmount: string;
  topics?: string[];
  data?: string;
}): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  return insertRawEvent({
    token_address: token,
    contract_address: input.pairAddress.toLowerCase(),
    event_name: input.eventName,
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    block_time: input.eventTime,
    from_address: input.trader.toLowerCase(),
    topics: input.topics,
    data: input.data,
    decoded_data: {
      eventType: input.eventType,
      trader: input.trader.toLowerCase(),
      tokenAmount: input.tokenAmount,
      quoteAmount: input.quoteAmount,
    },
  });
}

export async function ingestSyncLog(input: {
  tokenAddress: string;
  pairAddress: string;
  pairCtx: IngestPairCtx;
  reserve0: string;
  reserve1: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventTime: number;
  topics?: string[];
  data?: string;
}): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  return insertRawEvent({
    token_address: token,
    contract_address: input.pairAddress.toLowerCase(),
    event_name: 'Sync',
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    block_time: input.eventTime,
    topics: input.topics,
    data: input.data,
    decoded_data: {
      pairAddress: input.pairAddress.toLowerCase(),
      pairCtx: input.pairCtx,
      reserve0: input.reserve0,
      reserve1: input.reserve1,
    },
  });
}

export async function ingestPairCreatedLog(input: {
  tokenAddress: string;
  token0: string;
  token1: string;
  pairAddress: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventTime: number;
  topics?: string[];
  data?: string;
}): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  return insertRawEvent({
    token_address: token,
    contract_address: PANCAKE_FACTORY,
    event_name: 'PairCreated',
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    block_time: input.eventTime,
    topics: input.topics,
    data: input.data,
    decoded_data: {
      token0: input.token0.toLowerCase(),
      token1: input.token1.toLowerCase(),
      pairAddress: input.pairAddress.toLowerCase(),
    },
  });
}

export async function ingestStakingLog(input: {
  tokenAddress: string;
  contractAddress: string;
  eventName: string;
  user: string;
  txHash: string;
  logIndex: number;
  blockNumber: number;
  eventTime: number;
  topics?: string[];
  data?: string;
  args: unknown;
}): Promise<boolean> {
  const token = input.tokenAddress.toLowerCase();
  return insertRawEvent({
    token_address: token,
    contract_address: input.contractAddress.toLowerCase(),
    event_name: input.eventName,
    tx_hash: input.txHash,
    log_index: input.logIndex,
    block_number: input.blockNumber,
    block_time: input.eventTime,
    from_address: input.user.toLowerCase(),
    topics: input.topics,
    data: input.data,
    decoded_data: {
      eventName: input.eventName,
      user: input.user.toLowerCase(),
      args: input.args,
    },
  });
}
