import { Contract, isAddress, ZeroAddress, type Provider } from 'ethers';
import { PANCAKE_FACTORY, QUOTE_TOKENS, MONITOR_WALLET } from '../config.js';
import { FACTORY_ABI, PAIR_ABI } from '../abis.js';
import type { TokenStatus } from '../lifecycle.js';
import { fetchTokenMeta } from '../token/erc20.js';
import { getContract, upsertImportedContract, type DeployedContractRow } from '../db/repos/contractRepo.js';
import { getPairByToken, insertPair } from '../db/repos/pairRepo.js';
import { ensureMarketCachePlaceholder } from '../db/repos/marketRepo.js';
import { loadEcosystemContracts } from '../monitorTokens.js';
import { hasSwapEvent } from '../db/repos/eventRepo.js';
import { getMeta, setMeta } from '../db/index.js';
import { resolveQuoteToken, quoteSymbol } from '../swap/parse.js';

export interface ImportTokenInput {
  contract_address: string;
  pair_address?: string;
}

export interface ImportTokenResult {
  contract: DeployedContractRow;
  pair_address: string | null;
  status: TokenStatus;
  created: boolean;
  pair_discovered: boolean;
}

async function enqueueWorkerSubscribe(contractAddress: string): Promise<void> {
  const addr = contractAddress.toLowerCase();
  let queue: string[] = [];
  try {
    queue = JSON.parse((await getMeta('token_import_queue')) ?? '[]') as string[];
  } catch {
    queue = [];
  }
  if (!queue.includes(addr)) queue.push(addr);
  await setMeta('token_import_queue', JSON.stringify(queue));
}

async function discoverPairOnFactory(
  provider: Provider,
  tokenAddress: string,
): Promise<{
  pair_address: string;
  token0: string;
  token1: string;
  quote_token: string;
} | null> {
  const token = tokenAddress.toLowerCase();
  const factory = new Contract(PANCAKE_FACTORY, FACTORY_ABI, provider);

  const eco = loadEcosystemContracts();
  const extraQuotes: string[] = [];
  if (token !== eco.au && eco.au) extraQuotes.push(eco.au);

  for (const quote of [...extraQuotes, ...QUOTE_TOKENS]) {
    let pairAddr: string;
    try {
      pairAddr = await factory.getPair(token, quote);
    } catch {
      continue;
    }
    if (!pairAddr || pairAddr === ZeroAddress) continue;

    const pair = new Contract(pairAddr, PAIR_ABI, provider);
    const [token0, token1] = await Promise.all([pair.token0(), pair.token1()]);
    const t0 = String(token0).toLowerCase();
    const t1 = String(token1).toLowerCase();
    if (t0 !== token && t1 !== token) continue;

    const quoteToken = resolveQuoteToken(t0, t1);
    if (!quoteToken) continue;

    return {
      pair_address: pairAddr.toLowerCase(),
      token0: t0,
      token1: t1,
      quote_token: quoteToken,
    };
  }
  return null;
}

async function registerPair(
  tokenAddress: string,
  pairAddress: string,
  provider: Provider,
): Promise<{ token0: string; token1: string; quote_token: string } | null> {
  const token = tokenAddress.toLowerCase();
  const pair = pairAddress.toLowerCase();
  const existing = await getPairByToken(token);
  if (existing?.pair_address === pair) {
    return {
      token0: String(existing.token0).toLowerCase(),
      token1: String(existing.token1).toLowerCase(),
      quote_token: String(existing.quote_token).toLowerCase(),
    };
  }

  const pairContract = new Contract(pair, PAIR_ABI, provider);
  const [token0, token1] = await Promise.all([pairContract.token0(), pairContract.token1()]);
  const t0 = String(token0).toLowerCase();
  const t1 = String(token1).toLowerCase();
  if (t0 !== token && t1 !== token) return null;

  const quoteToken = resolveQuoteToken(t0, t1);
  if (!quoteToken) return null;

  await insertPair({
    token_address: token,
    pair_address: pair,
    token0: t0,
    token1: t1,
    quote_token: quoteToken,
    quote_symbol: quoteSymbol(quoteToken),
  });

  return { token0: t0, token1: t1, quote_token: quoteToken };
}

async function resolveStatus(tokenAddress: string, hasPair: boolean): Promise<TokenStatus> {
  if (await hasSwapEvent(tokenAddress)) return 'trading_started';
  if (hasPair) return 'liquidity_created';
  return 'deployed_no_liquidity';
}

export async function importToken(
  provider: Provider,
  input: ImportTokenInput,
): Promise<ImportTokenResult> {
  const raw = input.contract_address.trim();
  if (!isAddress(raw)) {
    throw new Error('无效的合约地址');
  }
  const contractAddress = raw.toLowerCase();
  const existedBefore = !!await getContract(contractAddress);

  const meta = await fetchTokenMeta(provider, contractAddress);
  if (!meta) {
    throw new Error('无法读取 ERC20 信息，请确认地址为 BEP20 Token');
  }

  let pairAddress: string | null = input.pair_address?.trim().toLowerCase() ?? null;
  let pairDiscovered = false;

  if (pairAddress) {
    if (!isAddress(pairAddress)) throw new Error('无效的 Pair 地址');
    const registered = await registerPair(contractAddress, pairAddress, provider);
    if (!registered) {
      throw new Error('Pair 地址与 Token 不匹配，或无法识别 Quote Token');
    }
  } else {
    const discovered = await discoverPairOnFactory(provider, contractAddress);
    if (discovered) {
      pairAddress = discovered.pair_address;
      pairDiscovered = true;
      if (!await getPairByToken(contractAddress)) {
        await insertPair({
          token_address: contractAddress,
          pair_address: discovered.pair_address,
          token0: discovered.token0,
          token1: discovered.token1,
          quote_token: discovered.quote_token,
          quote_symbol: quoteSymbol(discovered.quote_token),
        });
      }
    }
  }

  const hasPair = !!(pairAddress || await getPairByToken(contractAddress));
  const status = await resolveStatus(contractAddress, hasPair);
  const blockNumber = await provider.getBlockNumber();

  await upsertImportedContract({
    deployer_address: MONITOR_WALLET,
    contract_address: contractAddress,
    tx_hash: `import:${Date.now()}`,
    block_number: blockNumber,
    deploy_time: Date.now(),
    is_token: true,
    token_name: meta.name,
    token_symbol: meta.symbol,
    token_decimals: meta.decimals,
    total_supply: meta.totalSupply,
    status,
  });

  const contract = await getContract(contractAddress);
  if (!contract) throw new Error('导入后写入数据库失败');

  await ensureMarketCachePlaceholder(contractAddress, meta.symbol);
  await enqueueWorkerSubscribe(contractAddress);

  return {
    contract,
    pair_address:
      pairAddress ?? ((await getPairByToken(contractAddress))?.pair_address as string) ?? null,
    status,
    created: !existedBefore,
    pair_discovered: pairDiscovered,
  };
}

export async function drainImportQueue(): Promise<string[]> {
  const raw = await getMeta('token_import_queue');
  if (!raw) return [];
  await setMeta('token_import_queue', '[]');
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
