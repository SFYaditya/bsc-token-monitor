export type TokenStatus =
  | 'deployed_no_liquidity'
  | 'liquidity_created'
  | 'trading_started';

export type EventType =
  | 'transfer'
  | 'buy'
  | 'sell'
  | 'add_liquidity'
  | 'remove_liquidity'
  | 'stake'
  | 'unstake'
  | 'claim';

export const STATUS_LABELS: Record<TokenStatus, string> = {
  deployed_no_liquidity: 'Token 已部署，正在等待创建流动性',
  liquidity_created: 'LP 已创建，正在等待交易',
  trading_started: '已开始交易，监控中',
};

export const EVENT_TYPE_LABELS: Record<EventType, string> = {
  transfer: '转账',
  buy: '买入',
  sell: '卖出',
  add_liquidity: '添加流动性',
  remove_liquidity: '移除流动性',
  stake: '质押',
  unstake: '解押',
  claim: '领取收益',
};
