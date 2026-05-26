import { Contract, type Provider } from 'ethers';
import { PAIR_ABI, FACTORY_ABI } from '../abis.js';
import { BNB_PRICE_USD, PANCAKE_FACTORY, USDT, WBNB } from '../config.js';
import { fetchTokenMeta } from '../token/erc20.js';
import { getPairByToken } from '../db/repos/pairRepo.js';
import { quoteSymbol } from '../swap/parse.js';

export interface PairReserves {
  tokenReserve: bigint;
  quoteReserve: bigint;
  tokenDecimals: number;
  quoteDecimals: number;
  quoteToken: string;
  quoteSymbol: string;
  tokenIsToken0: boolean;
}

export interface MarketSnapshot {
  priceUsd: number;
  liquidityUsd: number;
  tokenReserve: string;
  quoteReserve: string;
}

let wbnbUsdCache = { price: BNB_PRICE_USD, at: 0 };

export async function fetchWbnbUsd(provider: Provider): Promise<number> {
  if (Date.now() - wbnbUsdCache.at < 60_000 && wbnbUsdCache.price > 0) {
    return wbnbUsdCache.price;
  }
  try {
    const factory = new Contract(PANCAKE_FACTORY, FACTORY_ABI, provider);
    const pairAddr: string = await factory.getPair(WBNB, USDT);
    if (!pairAddr || pairAddr === '0x0000000000000000000000000000000000000000') {
      return BNB_PRICE_USD;
    }
    const pair = new Contract(pairAddr, PAIR_ABI, provider);
    const [token0, reserves] = await Promise.all([pair.token0(), pair.getReserves()]);
    const r0 = reserves[0] as bigint;
    const r1 = reserves[1] as bigint;
    const t0 = String(token0).toLowerCase();
    const wbnbReserve = t0 === WBNB ? r0 : r1;
    const usdtReserve = t0 === WBNB ? r1 : r0;
    if (wbnbReserve === 0n) return BNB_PRICE_USD;
    const price = (Number(usdtReserve) / 1e18) / (Number(wbnbReserve) / 1e18);
    wbnbUsdCache = { price: price > 0 ? price : BNB_PRICE_USD, at: Date.now() };
    return wbnbUsdCache.price;
  } catch {
    return BNB_PRICE_USD;
  }
}

export function quoteToUsd(quoteAmount: bigint, quoteDecimals: number, quoteToken: string, wbnbUsd: number): number {
  const q = quoteToken.toLowerCase();
  const human = Number(quoteAmount) / 10 ** quoteDecimals;
  if (q === USDT || quoteSymbol(q) === 'USDT' || quoteSymbol(q) === 'BUSD') {
    return human;
  }
  if (q === WBNB || quoteSymbol(q) === 'WBNB') {
    return human * wbnbUsd;
  }
  // Unknown quote token: without a trusted oracle, avoid treating it as $1.
  return 0;
}

export async function readPairReserves(
  provider: Provider,
  tokenAddress: string,
): Promise<PairReserves | null> {
  const pairRow = await getPairByToken(tokenAddress);
  if (!pairRow?.pair_address) return null;

  const pair = new Contract(String(pairRow.pair_address), PAIR_ABI, provider);
  const [token0, reserves] = await Promise.all([pair.token0(), pair.getReserves()]);
  const t0 = String(token0).toLowerCase();
  const token = tokenAddress.toLowerCase();
  const quote = String(pairRow.quote_token).toLowerCase();
  const tokenIsToken0 = t0 === token;

  const [tokenMeta, quoteMeta] = await Promise.all([
    fetchTokenMeta(provider, token),
    fetchTokenMeta(provider, quote),
  ]);
  if (!tokenMeta) return null;

  const r0 = reserves[0] as bigint;
  const r1 = reserves[1] as bigint;
  return {
    tokenReserve: tokenIsToken0 ? r0 : r1,
    quoteReserve: tokenIsToken0 ? r1 : r0,
    tokenDecimals: tokenMeta.decimals,
    quoteDecimals: quoteMeta?.decimals ?? 18,
    quoteToken: quote,
    quoteSymbol: String(pairRow.quote_symbol ?? quoteSymbol(quote)),
    tokenIsToken0,
  };
}

export function priceFromReserves(reserves: PairReserves, wbnbUsd: number): MarketSnapshot {
  const tokenHuman = Number(reserves.tokenReserve) / 10 ** reserves.tokenDecimals;
  const quoteHuman = Number(reserves.quoteReserve) / 10 ** reserves.quoteDecimals;
  const priceInQuote = tokenHuman > 0 ? quoteHuman / tokenHuman : 0;
  // USD value of 1 quote token (e.g. 1 USDT == $1, 1 WBNB == wbnbUsd).
  const quoteUsdPer1 = quoteToUsd(
    10n ** BigInt(reserves.quoteDecimals),
    reserves.quoteDecimals,
    reserves.quoteToken,
    wbnbUsd,
  );
  const priceUsd = quoteUsdPer1 > 0 ? priceInQuote * quoteUsdPer1 : 0;
  const liquidityUsd = quoteUsdPer1 > 0 ? quoteHuman * quoteUsdPer1 * 2 : 0;

  return {
    priceUsd,
    liquidityUsd,
    tokenReserve: reserves.tokenReserve.toString(),
    quoteReserve: reserves.quoteReserve.toString(),
  };
}

export async function fetchTokenMarket(
  provider: Provider,
  tokenAddress: string,
): Promise<MarketSnapshot | null> {
  const reserves = await readPairReserves(provider, tokenAddress);
  if (!reserves) return null;
  const wbnbUsd = await fetchWbnbUsd(provider);
  return priceFromReserves(reserves, wbnbUsd);
}

export function swapQuoteUsd(
  quoteAmount: bigint,
  quoteDecimals: number,
  quoteToken: string,
  wbnbUsd: number,
): number {
  return quoteToUsd(quoteAmount, quoteDecimals, quoteToken, wbnbUsd);
}
