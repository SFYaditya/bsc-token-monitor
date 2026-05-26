export interface EcosystemContracts {
  usdt: string;
  router: string;
  userHierarchy: string;
  au: string;
  stakingPool: string;
  vault: string;
  otc: string;
  studio: string;
  academy: string;
  minePool: string;
  auUsdtPair: string;
}

export interface TokenConfig {
  name: string;
  symbol: string;
  tokenAddress: string;
  decimals: number;
  pairAddress: string;
  quoteTokenAddress: string;
  quoteSymbol: string;
  routerAddress?: string;
  stakingContractAddress?: string;
  /** CAT LP 质押合约（如 MasterChef / Farm） */
  lpStakingContractAddress?: string;
  /** LP 质押池 pid，默认 0 */
  lpStakingPid?: number;
  /** LP 质押合约部署/起始区块（用于扫描 LP 转入质押合约） */
  lpStakingFromBlock?: number;
  projectAddress?: string;
  projectAddresses?: string[];
  startBlock?: number;
  /** 无 Pair 时也可直接监控这些地址的链上余额（写入持仓榜） */
  watchAddresses?: string[];
  /** 单笔买入/卖出 Telegram 阈值（USD），未设则用 ALERT_LARGE_TRADE_USD */
  alertLargeTradeUsd?: number;
  /** 为 true 时该代币每笔买入（amountUsd>0）均推送 Telegram */
  notifyBuyTelegram?: boolean;
  /** 为 true 时该代币每笔卖出（amountUsd>0）均推送 Telegram */
  notifySellTelegram?: boolean;
  enabled: boolean;
}

export interface TokenMarket {
  tokenAddress: string;
  symbol: string;
  priceUsd: number;
  priceChange5m: number;
  priceChange15m: number;
  priceChange1h: number;
  priceChange24h: number;
  high24h: number;
  low24h: number;
  volume24hUsd: number;
  liquidityUsd: number;
  tokenReserve: string;
  quoteReserve: string;
  holderCount: number;
  updatedAt: number;
}

export interface TokenStats24h {
  tokenAddress: string;
  buyCount24h: number;
  sellCount24h: number;
  buyVolume24hUsd: number;
  sellVolume24hUsd: number;
  netBuyVolume24hUsd: number;
  activeWallets24h: number;
}

export interface AddressTokenProfile {
  tokenAddress: string;
  walletAddress: string;
  walletBalance: string;
  stakingBalance: string;
  lpBalanceRaw?: string;
  lpStakedBalanceRaw?: string;
  lpBalanceUsd?: number;
  lpStakedBalanceUsd?: number;
  balancePercent: number;
  buyCount: number;
  sellCount: number;
  totalBuyAmount: string;
  totalBuyUsd: number;
  totalSellAmount: string;
  totalSellUsd: number;
  netBuyAmount: string;
  netBuyUsd: number;
  avgBuyPrice: number;
  avgSellPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  totalPnl: number;
  roi: number;
  firstBuyTime?: number;
  lastTradeTime?: number;
  isCleared: boolean;
  isWhale: boolean;
  isBot: boolean;
  isSmartMoney: boolean;
  isProject: boolean;
  isContract: boolean;
  labels: string[];
}

export interface WhaleRule {
  minSingleTradeUsd: number;
  minHoldingUsd: number;
  minHoldingPercent: number;
}

export interface AlertEventRow {
  id: number;
  alert_type: string;
  token_address: string | null;
  level: string;
  wallet_address: string | null;
  tx_hash: string | null;
  amount_usd: number | null;
  message: string;
  handled: number;
  created_at: number;
}
