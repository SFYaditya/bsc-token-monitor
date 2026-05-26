/** 界面与链上数据字段的中文映射 */

const ALERT_TYPE_ZH: Record<string, string> = {
  test: '测试通知',
  lp_created: '创建流动性',
  liquidity_drop: '流动性下降',
  liquidity_remove: '移除流动性',
  large_remove_liquidity: '大额撤池',
  large_buy: '大额买入',
  large_sell: '大额卖出',
  whale_buy: '巨鲸买入',
  whale_sell: '巨鲸卖出',
  whale_first_buy: '巨鲸首次买入',
  project_sell: '项目方卖出',
  project_transfer: '项目方转账',
  unstake_then_sell: '解押后卖出',
  price_spike: '价格异动',
  price_drop: '价格下跌',
  rpc_failover: 'RPC 自动切换',
  rpc_manual_switch: 'RPC 手动切换',
  rpc_rate_limited: 'RPC 限流',
  rpc_node_removed: 'RPC 节点已移除',
  rpc_high_latency: 'RPC 高延迟',
  rpc_unavailable: 'RPC 不可用',
};

const RPC_STATUS_ZH: Record<string, string> = {
  HEALTHY: '正常',
  HIGH_LATENCY: '高延迟',
  RATE_LIMITED: '限流',
  UNAVAILABLE: '不可用',
  UNKNOWN: '未知',
};

export function zhRpcStatus(status: string): string {
  return RPC_STATUS_ZH[status.toUpperCase()] ?? status;
}

const ALERT_LEVEL_ZH: Record<string, string> = {
  HIGH: '高',
  MEDIUM: '中',
  LOW: '低',
  CRITICAL: '严重',
};

const ADDRESS_LABEL_ZH: Record<string, string> = {
  whale: '巨鲸',
  bot: '机器人',
  smart_money: '聪明钱',
  project: '项目方',
  exchange: '交易所',
  new_wallet: '新钱包',
};

const TOKEN_STATUS_ZH: Record<string, string> = {
  deployed_no_liquidity: '已部署，等待流动性',
  liquidity_created: '已有 LP，等待交易',
  trading_started: '交易中',
};

const EVENT_TYPE_ZH: Record<string, string> = {
  transfer: '转账',
  buy: '买入',
  sell: '卖出',
  add_liquidity: '添加流动性',
  remove_liquidity: '移除流动性',
  stake: '质押',
  unstake: '解押',
  claim: '领取收益',
};

export function zhAlertType(type: string | undefined): string {
  if (!type) return '—';
  const key = type.toLowerCase();
  if (ALERT_TYPE_ZH[key]) return ALERT_TYPE_ZH[key];
  return type
    .replace(/_/g, ' ')
    .replace(/\bwhale\b/gi, '巨鲸')
    .replace(/\bbuy\b/gi, '买入')
    .replace(/\bsell\b/gi, '卖出')
    .replace(/\bliquidity\b/gi, '流动性')
    .replace(/\blarge\b/gi, '大额')
    .replace(/\bproject\b/gi, '项目方');
}

export function zhAlertLevel(level: string | undefined): string {
  if (!level) return '—';
  return ALERT_LEVEL_ZH[String(level).toUpperCase()] ?? String(level);
}

export function zhAddressLabel(label: string | undefined): string {
  if (!label) return '—';
  const key = label.toLowerCase();
  return ADDRESS_LABEL_ZH[key] ?? label;
}

export function zhTokenStatus(status: string | undefined): string {
  if (!status) return '—';
  return TOKEN_STATUS_ZH[status] ?? status;
}

export function zhEventType(type: string | undefined): string {
  if (!type) return '—';
  const key = String(type).toLowerCase();
  return EVENT_TYPE_ZH[key] ?? type;
}

export function zhTrend(trend: string | undefined): string {
  const t = String(trend ?? '').toUpperCase();
  if (t === 'BULLISH') return '看多';
  if (t === 'BEARISH') return '看空';
  if (t === 'NEUTRAL') return '中性';
  return trend ? String(trend) : '—';
}

export function zhRiskLevel(level: string | undefined): string {
  const l = String(level ?? '').toLowerCase();
  if (l.includes('high') || l === '高' || l === 'critical') return '高';
  if (l.includes('medium') || l === '中') return '中';
  if (l.includes('low') || l === '低') return '低';
  return level ? String(level) : '—';
}

export function zhApiError(msg: string): string {
  const m = msg.toLowerCase();
  if (m.includes('invalid password')) return '密码错误';
  if (m.includes('not found')) return '未找到数据';
  if (m.includes('network') || m.includes('fetch')) return '网络请求失败';
  if (m.includes('unauthorized') || m.includes('401')) return '未授权，请重新登录';
  return msg;
}

/** 表格列名等固定文案 */
export const UI = {
  brand: '链察',
  brandSub: 'BSC 链上交易监控',
  usd: '美元',
  txHash: '交易哈希',
  address: '地址',
  time: '时间',
  type: '类型',
  amount: '金额',
  level: '等级',
  rank: '排名',
  percent: '占比',
  quantity: '数量',
  viewOnChain: '链上查看',
  copy: '复制',
  copied: '已复制',
  refresh: '刷新',
  loading: '加载中…',
  noData: '暂无数据',
  all: '全部',
  buy: '买入',
  sell: '卖出',
  rpc: '节点',
  ms: '毫秒',
  pair: '交易对',
  blockFrom: '起始区块',
  blockTo: '结束区块',
  roi: '投资回报率',
  telegram: 'Telegram 通知',
  token: '代币',
  hour24: '24 小时',
  hour24Short: '24 小时',
  day7: '7 天',
  pairAddress: '交易对地址',
  lockerAddress: '锁仓地址',
  viewToken: '查看代币',
  enterPassword: '请输入访问密码',
  scanDone: '扫描完成',
} as const;
