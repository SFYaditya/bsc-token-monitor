import { QUOTE_TOKENS } from '../config.js';

export interface PairCtx {
  pairAddress: string;
  tokenAddress: string;
  quoteToken: string;
  tokenIsToken0: boolean;
  tokenDecimals: number;
  quoteDecimals: number;
}

export function resolveQuoteToken(token0: string, token1: string): string | null {
  const t0 = token0.toLowerCase();
  const t1 = token1.toLowerCase();
  if (QUOTE_TOKENS.includes(t0)) return t0;
  if (QUOTE_TOKENS.includes(t1)) return t1;
  return null;
}

export function parseSwap(
  ctx: PairCtx,
  amount0In: bigint,
  amount1In: bigint,
  amount0Out: bigint,
  amount1Out: bigint,
): { tradeType: 'buy' | 'sell'; tokenAmount: bigint; quoteAmount: bigint; price: number } | null {
  const tokenIn = ctx.tokenIsToken0 ? amount0In : amount1In;
  const tokenOut = ctx.tokenIsToken0 ? amount0Out : amount1Out;
  const quoteIn = ctx.tokenIsToken0 ? amount1In : amount0In;
  const quoteOut = ctx.tokenIsToken0 ? amount1Out : amount0Out;
  const tDec = 10 ** ctx.tokenDecimals;
  const qDec = 10 ** ctx.quoteDecimals;

  if (tokenOut > 0n && quoteIn > 0n) {
    const price = Number(quoteIn) / qDec / (Number(tokenOut) / tDec);
    return { tradeType: 'buy', tokenAmount: tokenOut, quoteAmount: quoteIn, price };
  }
  if (tokenIn > 0n && quoteOut > 0n) {
    const price = Number(quoteOut) / qDec / (Number(tokenIn) / tDec);
    return { tradeType: 'sell', tokenAmount: tokenIn, quoteAmount: quoteOut, price };
  }
  return null;
}

export function quoteSymbol(quoteToken: string): string {
  const q = quoteToken.toLowerCase();
  if (q.includes('55d398')) return 'USDT';
  if (q.includes('bb4cdb')) return 'WBNB';
  if (q.includes('e9e7ce')) return 'BUSD';
  return 'QUOTE';
}
