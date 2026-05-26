import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EcosystemContracts, TokenConfig } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const CONFIG_PATH =
  process.env.MONITOR_TOKENS_PATH?.trim() ||
  path.join(ROOT, 'data', 'monitor-tokens.json');

let cached: TokenConfig[] | null = null;
let cachedProjectAddresses: string[] | null = null;
let cachedEcosystem: EcosystemContracts | null = null;

const DEFAULT_ECOSYSTEM: EcosystemContracts = {
  usdt: '0x55d398326f99059ff775485246999027b3197955',
  router: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
  userHierarchy: '0x3ed53fea75dd3c4be40eb48b84bc3ff86deb7607',
  au: '0xcab65560a5b4271d3ca08d9de14c5017495d14fb',
  stakingPool: '0xe52ffa097f58978ac05ff81eee874ec5fd54d21c',
  vault: '0x519be7d237a84dae69072161ca7234a6e2fd5a06',
  otc: '0xb638b034a6a4c8c855856fcdf686fab03af456c3',
  studio: '0xa1b897873545d8be5c093b851c160dcdae219675',
  academy: '0x6dc734ecb08319de0e2426c40799441678cfa8df',
  minePool: '0x883c82f152ba370d813ae42d2a70483b14626124',
  auUsdtPair: '0xd1459ea7c8c5db50422be962d43bb350380ecfc1',
};

function normalizeAddress(raw: unknown): string {
  const a = String(raw ?? '').trim().toLowerCase();
  return a.startsWith('0x') ? a : '';
}

function normalizeEcosystem(raw: Record<string, unknown> | undefined): EcosystemContracts {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ECOSYSTEM };
  return {
    usdt: normalizeAddress(raw.usdt ?? raw.USDT) || DEFAULT_ECOSYSTEM.usdt,
    router: normalizeAddress(raw.router ?? raw.Router) || DEFAULT_ECOSYSTEM.router,
    userHierarchy:
      normalizeAddress(raw.userHierarchy ?? raw.UserHierarchy) ||
      DEFAULT_ECOSYSTEM.userHierarchy,
    au: normalizeAddress(raw.au ?? raw.AU) || DEFAULT_ECOSYSTEM.au,
    stakingPool:
      normalizeAddress(raw.stakingPool ?? raw.StakingPool) || DEFAULT_ECOSYSTEM.stakingPool,
    vault: normalizeAddress(raw.vault ?? raw.Vault) || DEFAULT_ECOSYSTEM.vault,
    otc: normalizeAddress(raw.otc ?? raw.OTC) || DEFAULT_ECOSYSTEM.otc,
    studio: normalizeAddress(raw.studio ?? raw.Studio) || DEFAULT_ECOSYSTEM.studio,
    academy: normalizeAddress(raw.academy ?? raw.Academy) || DEFAULT_ECOSYSTEM.academy,
    minePool: normalizeAddress(raw.minePool ?? raw.MinePool) || DEFAULT_ECOSYSTEM.minePool,
    auUsdtPair:
      normalizeAddress(raw.auUsdtPair ?? raw['AU/USDT Pair'] ?? raw.au_usdt_pair) ||
      DEFAULT_ECOSYSTEM.auUsdtPair,
  };
}

function normalizeEntry(raw: Record<string, unknown>): TokenConfig | null {
  const tokenAddress = String(
    raw.tokenAddress ?? raw.token_address ?? '',
  ).toLowerCase();
  if (!tokenAddress || !tokenAddress.startsWith('0x')) return null;
  return {
    name: String(raw.name ?? ''),
    symbol: String(raw.symbol ?? ''),
    tokenAddress,
    decimals: Number(raw.decimals ?? 18),
    pairAddress: String(raw.pairAddress ?? raw.pair_address ?? '')
      .trim()
      .toLowerCase(),
    quoteTokenAddress: String(
      raw.quoteTokenAddress ?? raw.quote_token_address ?? '',
    ).toLowerCase(),
    quoteSymbol: String(raw.quoteSymbol ?? raw.quote_symbol ?? 'USDT'),
    routerAddress: raw.routerAddress
      ? String(raw.routerAddress).toLowerCase()
      : undefined,
    stakingContractAddress: raw.stakingContractAddress
      ? String(raw.stakingContractAddress).toLowerCase()
      : undefined,
    lpStakingContractAddress: raw.lpStakingContractAddress
      ? String(raw.lpStakingContractAddress).toLowerCase()
      : raw.lp_staking_contract_address
        ? String(raw.lp_staking_contract_address).toLowerCase()
        : undefined,
    lpStakingPid:
      raw.lpStakingPid != null
        ? Number(raw.lpStakingPid)
        : raw.lp_staking_pid != null
          ? Number(raw.lp_staking_pid)
          : undefined,
    lpStakingFromBlock:
      raw.lpStakingFromBlock != null
        ? Number(raw.lpStakingFromBlock)
        : raw.lp_staking_from_block != null
          ? Number(raw.lp_staking_from_block)
          : undefined,
    startBlock: raw.startBlock != null ? Number(raw.startBlock) : undefined,
    watchAddresses: Array.isArray(raw.watchAddresses)
      ? (raw.watchAddresses as string[])
          .map((a) => String(a).trim().toLowerCase())
          .filter((a) => a.startsWith('0x'))
      : undefined,
    alertLargeTradeUsd:
      raw.alertLargeTradeUsd != null
        ? Number(raw.alertLargeTradeUsd)
        : raw.alert_large_trade_usd != null
          ? Number(raw.alert_large_trade_usd)
          : undefined,
    notifyBuyTelegram:
      raw.notifyBuyTelegram === true ||
      raw.notify_buy_telegram === true ||
      raw.notifyBuyTelegram === 'true',
    notifySellTelegram:
      raw.notifySellTelegram === true ||
      raw.notify_sell_telegram === true ||
      raw.notifySellTelegram === 'true',
    enabled: raw.enabled !== false,
  };
}

function loadConfigFile(): Record<string, unknown> {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function loadEcosystemContracts(force = false): EcosystemContracts {
  if (cachedEcosystem && !force) return cachedEcosystem;
  const parsed = loadConfigFile();
  cachedEcosystem = normalizeEcosystem(
    parsed.ecosystem as Record<string, unknown> | undefined,
  );
  return cachedEcosystem;
}

export function loadProjectAddresses(force = false): string[] {
  if (cachedProjectAddresses && !force) return cachedProjectAddresses;
  const parsed = loadConfigFile();
  const eco = loadEcosystemContracts(force);
  const fromEcosystem = [eco.vault, eco.otc, eco.studio, eco.academy, eco.minePool];
  const fromRoot = Array.isArray(parsed.projectAddresses)
    ? (parsed.projectAddresses as string[])
    : [];
  const fromTokens = (Array.isArray(parsed.tokens) ? parsed.tokens : []).flatMap((t) => {
    const raw = t as Record<string, unknown>;
    const single = raw.projectAddress ?? raw.project_address;
    const many = raw.projectAddresses ?? raw.project_addresses;
    const list: string[] = [];
    if (single) list.push(String(single));
    if (Array.isArray(many)) list.push(...many.map(String));
    return list;
  });
  cachedProjectAddresses = [...new Set([...fromRoot, ...fromTokens, ...fromEcosystem])]
    .map((a) => a.toLowerCase())
    .filter((a) => a.startsWith('0x'));
  return cachedProjectAddresses;
}

export function loadMonitorTokens(force = false): TokenConfig[] {
  if (cached && !force) return cached;
  const parsed = loadConfigFile();
  if (!Object.keys(parsed).length) {
    cached = [];
    return cached;
  }
  try {
    const list = Array.isArray(parsed.tokens) ? parsed.tokens : [];
    cached = list
      .map((t) => normalizeEntry(t))
      .filter((t): t is TokenConfig => !!t && t.enabled);
    if (force) {
      loadProjectAddresses(true);
      loadEcosystemContracts(true);
    }
  } catch {
    cached = [];
  }
  return cached;
}

export function getMonitoredTokenAddresses(force = false): Set<string> {
  return new Set(loadMonitorTokens(force).map((t) => t.tokenAddress.toLowerCase()));
}

export function isMonitoredToken(tokenAddress: string, force = false): boolean {
  return getMonitoredTokenAddresses(force).has(tokenAddress.toLowerCase());
}

export function getMonitorToken(tokenAddress: string): TokenConfig | undefined {
  const addr = tokenAddress.toLowerCase();
  const row = loadMonitorTokens().find((t) => t.tokenAddress === addr);
  if (!row) return undefined;
  const eco = loadEcosystemContracts();
  if (addr === eco.au) {
    return {
      ...row,
      pairAddress: row.pairAddress || eco.auUsdtPair,
      quoteTokenAddress: row.quoteTokenAddress || eco.usdt,
      routerAddress: row.routerAddress || eco.router,
      stakingContractAddress: row.stakingContractAddress || eco.stakingPool,
    };
  }
  return row;
}
