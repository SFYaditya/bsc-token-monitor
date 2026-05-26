import { Contract, type Provider } from 'ethers';
import {
  ERC20_ABI,
  FACTORY_ABI,
  PAIR_ABI,
  PANCAKE_FACTORY,
  MONITOR_WALLET,
  listContracts,
  fetchTokenMeta,
  insertDeployedContract,
  getPairByToken,
  LISTENER_ENABLE_WSS_EVENTS,
  parseSwap,
  ingestTransferLog,
  ingestSwapLog,
  ingestLiquidityLog,
  ingestSyncLog,
  ingestPairCreatedLog,
  resolveQuoteToken,
  quoteSymbol,
  countHolders,
  backfillTokenHolders,
  isMonitoredToken,
} from '@token-monitor/shared';
import { getTracked, setTracked, setPairAddress } from './registry.js';
import type { Log } from 'ethers';

export async function loadExistingTokens(provider: Provider): Promise<void> {
  const { items } = await listContracts({ pageSize: 500 });
  for (const c of items) {
    if (!isMonitoredToken(c.contract_address)) continue;
    await subscribeToken(provider, c.contract_address, c.token_decimals ?? 18, c.total_supply ?? '0');
  }
}

export async function subscribeToken(
  provider: Provider,
  address: string,
  decimals?: number,
  totalSupply?: string,
): Promise<void> {
  const addr = address.toLowerCase();
  if (getTracked(addr)) return;

  let dec = decimals;
  let supply = totalSupply;
  if (dec == null || !supply) {
    const meta = await fetchTokenMeta(provider, addr);
    if (!meta) return;
    dec = meta.decimals;
    supply = meta.totalSupply;
  }

  const tokenContract = new Contract(addr, ERC20_ABI, provider);
  const pairRow = await getPairByToken(addr);
  const pairAddr = pairRow?.pair_address as string | undefined;

  setTracked({
    address: addr,
    decimals: dec,
    totalSupply: supply,
    pairAddress: pairAddr?.toLowerCase(),
    transferContract: tokenContract,
  });

  if (LISTENER_ENABLE_WSS_EVENTS) {
    tokenContract.on('Transfer', async (from: string, to: string, value: bigint, ev: { log: Log }) => {
      try {
        const block = await provider.getBlock(ev.log.blockNumber);
        const eventTime = (block?.timestamp ?? 0) * 1000;
        await ingestTransferLog(provider, {
          tokenAddress: addr,
          decimals: dec!,
          totalSupply: supply!,
          from,
          to,
          value,
          txHash: ev.log.transactionHash,
          logIndex: ev.log.index,
          blockNumber: ev.log.blockNumber,
          eventTime,
          pairAddress: getTracked(addr)?.pairAddress,
          topics: ev.log.topics as string[],
          data: ev.log.data,
        });
      } catch (err) {
        console.error(
          `[WSS] Transfer ingest ${addr}:`,
          err instanceof Error ? err.message : err,
        );
      }
    });
    if (pairAddr) await subscribePairIngestOnly(provider, addr, pairAddr, dec!, supply!);
  }

  if ((await countHolders(addr)) === 0) {
    void backfillTokenHolders(provider, addr, dec!, supply!, pairAddr?.toLowerCase())
      .then((r) => {
        if (r.addresses > 0) {
          console.log(
            `[Holders] backfill ${addr.slice(0, 8)}… ${r.synced} holders from ${r.addresses} addresses (blocks ${r.fromBlock}-${r.toBlock})`,
          );
        }
      })
      .catch((err) => {
        console.error(
          `[Holders] backfill ${addr}:`,
          err instanceof Error ? err.message : err,
        );
      });
  }
}

export async function handleDeployment(
  provider: Provider,
  tx: { from?: string; hash: string },
  receipt: { contractAddress?: string | null; blockNumber?: number },
): Promise<void> {
  const deployer = tx.from?.toLowerCase();
  if (deployer !== MONITOR_WALLET) return;
  const contractAddress = receipt.contractAddress;
  if (!contractAddress) return;

  const meta = await fetchTokenMeta(provider, contractAddress);
  const block = receipt.blockNumber
    ? await provider.getBlock(receipt.blockNumber)
    : null;
  const deployTime = (block?.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;

  const isToken = !!meta;
  await insertDeployedContract({
    deployer_address: deployer,
    contract_address: contractAddress,
    tx_hash: tx.hash,
    block_number: receipt.blockNumber ?? 0,
    deploy_time: deployTime,
    is_token: isToken,
    token_name: meta?.name,
    token_symbol: meta?.symbol,
    token_decimals: meta?.decimals,
    total_supply: meta?.totalSupply,
    status: 'deployed_no_liquidity',
  });

  if (isToken && meta) {
    console.log(`[Deploy] Token ${meta.symbol} at ${contractAddress}`);
    await subscribeToken(provider, contractAddress, meta.decimals, meta.totalSupply);
  }
}

export function startFactoryListener(provider: Provider): void {
  const factory = new Contract(PANCAKE_FACTORY, FACTORY_ABI, provider);
  factory.on('PairCreated', async (token0: string, token1: string, pair: string, ev: { log: Log }) => {
    try {
      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      const tracked = getTracked(t0) || getTracked(t1);
      if (!tracked) return;

      const tokenAddr = getTracked(t0) ? t0 : t1;
      const block = await provider.getBlock(ev.log.blockNumber);
      const eventTime = (block?.timestamp ?? 0) * 1000;

      await ingestPairCreatedLog({
        tokenAddress: tokenAddr,
        token0: t0,
        token1: t1,
        pairAddress: pair,
        txHash: ev.log.transactionHash,
        logIndex: ev.log.index,
        blockNumber: ev.log.blockNumber,
        eventTime,
        topics: ev.log.topics as string[],
        data: ev.log.data,
      });

      setPairAddress(tokenAddr, pair);
      const t = getTracked(tokenAddr)!;
      if (LISTENER_ENABLE_WSS_EVENTS) {
        await subscribePairIngestOnly(provider, tokenAddr, pair, t.decimals, t.totalSupply);
      }
    } catch (err) {
      console.error(
        '[WSS] PairCreated ingest:',
        err instanceof Error ? err.message : err,
      );
    }
  });
}

/** WSS：仅 ingest → raw_events，不写业务表 */
async function subscribePairIngestOnly(
  provider: Provider,
  tokenAddress: string,
  pairAddress: string,
  decimals: number,
  totalSupply: string,
): Promise<void> {
  const pair = new Contract(pairAddress, PAIR_ABI, provider);
  const token0 = (await pair.token0()).toLowerCase();
  const token1 = (await pair.token1()).toLowerCase();
  const quote = resolveQuoteToken(token0, token1);
  if (!quote) return;

  const tokenIsToken0 = token0 === tokenAddress.toLowerCase();
  const quoteMeta = await fetchTokenMeta(provider, quote);
  const ctx = {
    pairAddress: pairAddress.toLowerCase(),
    tokenAddress: tokenAddress.toLowerCase(),
    quoteToken: quote,
    tokenIsToken0,
    tokenDecimals: decimals,
    quoteDecimals: quoteMeta?.decimals ?? 18,
  };

  const onSwap = async (
    _sender: string,
    a0In: bigint,
    a1In: bigint,
    a0Out: bigint,
    a1Out: bigint,
    _to: string,
    ev: { log: Log },
  ) => {
    try {
      const parsed = parseSwap(ctx, a0In, a1In, a0Out, a1Out);
      if (!parsed) return;
      const tx = await provider.getTransaction(ev.log.transactionHash);
      const trader = tx?.from?.toLowerCase() ?? _to.toLowerCase();
      const block = await provider.getBlock(ev.log.blockNumber);
      const eventTime = (block?.timestamp ?? 0) * 1000;
      await ingestSwapLog({
        tokenAddress,
        decimals,
        totalSupply,
        pairAddress,
        pairCtx: ctx,
        tradeType: parsed.tradeType,
        trader,
        tokenAmount: parsed.tokenAmount,
        quoteAmount: parsed.quoteAmount,
        price: parsed.price,
        txHash: ev.log.transactionHash,
        logIndex: ev.log.index,
        blockNumber: ev.log.blockNumber,
        eventTime,
        topics: ev.log.topics as string[],
        data: ev.log.data,
      });
    } catch (err) {
      console.error('[WSS] Swap ingest:', err instanceof Error ? err.message : err);
    }
  };

  const onSync = async (reserve0: bigint, reserve1: bigint, ev: { log: Log }) => {
    try {
      const block = await provider.getBlock(ev.log.blockNumber);
      const eventTime = (block?.timestamp ?? 0) * 1000;
      await ingestSyncLog({
        tokenAddress,
        pairAddress,
        pairCtx: ctx,
        reserve0: reserve0.toString(),
        reserve1: reserve1.toString(),
        txHash: ev.log.transactionHash,
        logIndex: ev.log.index,
        blockNumber: ev.log.blockNumber,
        eventTime,
        topics: ev.log.topics as string[],
        data: ev.log.data,
      });
    } catch (err) {
      console.error('[WSS] Sync ingest:', err instanceof Error ? err.message : err);
    }
  };

  const onMint = async (
    sender: string,
    amount0: bigint,
    amount1: bigint,
    ev: { log: Log },
  ) => {
    try {
      const block = await provider.getBlock(ev.log.blockNumber);
      const eventTime = (block?.timestamp ?? 0) * 1000;
      const tokenAmt = tokenIsToken0 ? amount0 : amount1;
      const quoteAmt = tokenIsToken0 ? amount1 : amount0;
      await ingestLiquidityLog({
        tokenAddress,
        eventName: 'Mint',
        eventType: 'add_liquidity',
        txHash: ev.log.transactionHash,
        logIndex: ev.log.index,
        blockNumber: ev.log.blockNumber,
        eventTime,
        pairAddress,
        trader: sender.toLowerCase(),
        tokenAmount: tokenAmt.toString(),
        quoteAmount: quoteAmt.toString(),
        topics: ev.log.topics as string[],
        data: ev.log.data,
      });
    } catch (err) {
      console.error('[WSS] Mint ingest:', err instanceof Error ? err.message : err);
    }
  };

  const onBurn = async (
    sender: string,
    amount0: bigint,
    amount1: bigint,
    _to: string,
    ev: { log: Log },
  ) => {
    try {
      const block = await provider.getBlock(ev.log.blockNumber);
      await ingestLiquidityLog({
        tokenAddress,
        eventName: 'Burn',
        eventType: 'remove_liquidity',
        txHash: ev.log.transactionHash,
        logIndex: ev.log.index,
        blockNumber: ev.log.blockNumber,
        eventTime: (block?.timestamp ?? 0) * 1000,
        pairAddress,
        trader: sender.toLowerCase(),
        tokenAmount: (tokenIsToken0 ? amount0 : amount1).toString(),
        quoteAmount: (tokenIsToken0 ? amount1 : amount0).toString(),
        topics: ev.log.topics as string[],
        data: ev.log.data,
      });
    } catch (err) {
      console.error('[WSS] Burn ingest:', err instanceof Error ? err.message : err);
    }
  };

  pair.on('Swap', onSwap);
  pair.on('Sync', onSync);
  pair.on('Mint', onMint);
  pair.on('Burn', onBurn);

  const tracked = getTracked(tokenAddress);
  if (tracked) tracked.pairContract = pair;
}
