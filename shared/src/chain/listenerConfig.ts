/** BSC Chain Listener — 分层 getLogs 配置 */

export const SYNC_BLOCK_CHUNK = Math.max(1, Number(process.env.SYNC_BLOCK_CHUNK ?? 2));
export const SYNC_CONFIRM_BLOCKS = Math.max(0, Number(process.env.SYNC_CONFIRM_BLOCKS ?? 3));
export const SYNC_MAX_RETRIES = Math.max(1, Number(process.env.SYNC_MAX_RETRIES ?? 3));
export const SYNC_RETRY_DELAY_MS = Math.max(200, Number(process.env.SYNC_RETRY_DELAY_MS ?? 1500));

/** Fast Pair：活跃 / 安静 扫描间隔（块） */
export const FAST_PAIR_INTERVAL_ACTIVE = Math.max(
  1,
  Number(process.env.FAST_PAIR_INTERVAL_ACTIVE ?? 2),
);
export const FAST_PAIR_INTERVAL_QUIET = Math.max(
  FAST_PAIR_INTERVAL_ACTIVE,
  Number(process.env.FAST_PAIR_INTERVAL_QUIET ?? 5),
);
export const FAST_PAIR_QUIET_MS = Number(process.env.FAST_PAIR_QUIET_MS ?? 10 * 60_000);

/** Medium MasterChef */
export const MEDIUM_MC_INTERVAL_ACTIVE = Math.max(
  1,
  Number(process.env.MEDIUM_MC_INTERVAL_ACTIVE ?? 10),
);
export const MEDIUM_MC_INTERVAL_QUIET = Math.max(
  MEDIUM_MC_INTERVAL_ACTIVE,
  Number(process.env.MEDIUM_MC_INTERVAL_QUIET ?? 20),
);
export const MEDIUM_MC_QUIET_MS = Number(process.env.MEDIUM_MC_QUIET_MS ?? 30 * 60_000);

/** 单次 eth_getLogs 最大块跨度（多数 BSC RPC 上限 25） */
export const SYNC_GETLOGS_MAX_BLOCK_RANGE = Math.max(
  1,
  Number(process.env.SYNC_GETLOGS_MAX_BLOCK_RANGE ?? 25),
);

/** Slow Transfer */
export const SLOW_TRANSFER_INTERVAL_ACTIVE = Math.max(
  1,
  Math.min(
    SYNC_GETLOGS_MAX_BLOCK_RANGE,
    Number(process.env.SLOW_TRANSFER_INTERVAL_ACTIVE ?? 25),
  ),
);
export const SLOW_TRANSFER_INTERVAL_QUIET = Math.max(
  SLOW_TRANSFER_INTERVAL_ACTIVE,
  Math.min(
    SYNC_GETLOGS_MAX_BLOCK_RANGE,
    Number(process.env.SLOW_TRANSFER_INTERVAL_QUIET ?? 25),
  ),
);
export const SLOW_TRANSFER_QUIET_MS = Number(process.env.SLOW_TRANSFER_QUIET_MS ?? 30 * 60_000);

/** 任意 eth_getLogs 最小间隔 */
export const SYNC_GETLOGS_MIN_INTERVAL_MS = Math.max(
  100,
  Number(process.env.SYNC_GETLOGS_MIN_INTERVAL_MS ?? 400),
);
export const SYNC_GETLOGS_MAX_BACKOFF_MS = Math.max(
  1000,
  Number(process.env.SYNC_GETLOGS_MAX_BACKOFF_MS ?? 30_000),
);

/** 启动时每类 listener 最多推进块段数 */
export const SYNC_BOOTSTRAP_MAX_CHUNKS_PER_TASK = Math.max(
  10,
  Number(process.env.SYNC_BOOTSTRAP_MAX_CHUNKS_PER_TASK ?? 60),
);

/** 每轮 poll 每类任务最多扫描次数 */
export const LISTENER_MAX_SCANS_PER_POLL = Math.max(
  1,
  Number(process.env.LISTENER_MAX_SCANS_PER_POLL ?? 3),
);

/** 目标：常态 lag 不超过该值（块） */
export const SYNC_TARGET_MAX_LAG_BLOCKS = Math.max(
  3,
  Number(process.env.SYNC_TARGET_MAX_LAG_BLOCKS ?? 20),
);
/** 落后超过该块数时进入大步长追块 */
export const SYNC_CATCHUP_LAG_BLOCKS = Math.max(
  5,
  Number(process.env.SYNC_CATCHUP_LAG_BLOCKS ?? SYNC_TARGET_MAX_LAG_BLOCKS),
);
/** 追块模式下单次计划块数（实际 getLogs 会在 batchedLogs 内再切分） */
export const SYNC_CATCHUP_CHUNK_BLOCKS = Math.max(
  1,
  Math.min(
    SYNC_GETLOGS_MAX_BLOCK_RANGE,
    Number(process.env.SYNC_CATCHUP_CHUNK_BLOCKS ?? SYNC_GETLOGS_MAX_BLOCK_RANGE),
  ),
);
/** 追块模式下每轮 poll 最多扫描次数 */
export const SYNC_CATCHUP_MAX_SCANS_PER_POLL = Math.max(
  LISTENER_MAX_SCANS_PER_POLL,
  Number(process.env.SYNC_CATCHUP_MAX_SCANS_PER_POLL ?? 20),
);
/** 深度落后（块）：加大每轮扫描、连续 burst 追块 */
export const SYNC_DEEP_LAG_BLOCKS = Math.max(
  100,
  Number(process.env.SYNC_DEEP_LAG_BLOCKS ?? 500),
);
export const SYNC_DEEP_CATCHUP_MAX_SCANS_PER_POLL = Math.max(
  SYNC_CATCHUP_MAX_SCANS_PER_POLL,
  Number(process.env.SYNC_DEEP_CATCHUP_MAX_SCANS_PER_POLL ?? 40),
);
/** 单次 poll 周期内连续追块的最长时间（毫秒） */
export const SYNC_BURST_POLL_MAX_MS = Math.max(
  5000,
  Number(process.env.SYNC_BURST_POLL_MAX_MS ?? 30_000),
);
/** 深度落后时 slow_transfer 每轮最多扫描次数（优先追 fast_pair） */
export const SYNC_DEEP_LAG_SLOW_MAX_SCANS = Math.max(
  1,
  Number(process.env.SYNC_DEEP_LAG_SLOW_MAX_SCANS ?? 6),
);
/** lag 超目标时缩短轮询间隔 */
export const LISTENER_POLL_FAST_MS = Math.max(
  800,
  Number(process.env.LISTENER_POLL_FAST_MS ?? 2000),
);

export const LISTENER_POLL_MS = Math.max(1000, Number(process.env.LISTENER_POLL_MS ?? 4000));
export const LISTENER_HEARTBEAT_MS = Math.max(3000, Number(process.env.LISTENER_HEARTBEAT_MS ?? 10_000));
/** sync_status / listener 心跳视为超时的阈值（追块时单次 poll 可能 >1 分钟） */
export const LISTENER_STALE_HEARTBEAT_MS = Math.max(
  LISTENER_HEARTBEAT_MS * 3,
  Number(process.env.LISTENER_STALE_HEARTBEAT_MS ?? 180_000),
);
export const LISTENER_LAG_ALERT_BLOCKS = Math.max(
  10,
  Number(process.env.LISTENER_LAG_ALERT_BLOCKS ?? 500),
);
export const LISTENER_HEALTH_CHECK_MS = Math.max(
  5000,
  Number(process.env.LISTENER_HEALTH_CHECK_MS ?? 30_000),
);

export const LISTENER_SERVICE_NAME = 'chain-listener';

/**
 * WSS 仅写入 raw_events（与 getLogs 相同入口），由 event-processor 幂等消费。
 * 设为 false 可关闭 WSS 合约事件（仅保留区块/deploy 与轮询 getLogs）。
 */
export const LISTENER_ENABLE_WSS_EVENTS =
  process.env.LISTENER_ENABLE_WSS_EVENTS !== 'false';

/** 交易事件是否跳过即时 balanceOf（改由定时校准） */
export const HOLDER_SKIP_BALANCEOF_ON_EVENT =
  process.env.HOLDER_SKIP_BALANCEOF_ON_EVENT !== 'false';

/** getReserves 兜底校准间隔 */
export const MARKET_RESERVES_CALIBRATE_MS = Math.max(
  60_000,
  Number(process.env.MARKET_RESERVES_CALIBRATE_MS ?? 3 * 60_000),
);

/** 持仓 balanceOf 校准间隔 */
export const HOLDER_CALIBRATE_MS = Math.max(
  60_000,
  Number(process.env.HOLDER_CALIBRATE_MS ?? 5 * 60_000),
);

export const LISTENER_SYNC_TYPES = {
  FAST_PAIR: 'fast_pair_listener',
  MEDIUM_MASTERCHEF: 'medium_masterchef_listener',
  SLOW_TRANSFER: 'slow_transfer_listener',
} as const;

export type ListenerSyncType =
  (typeof LISTENER_SYNC_TYPES)[keyof typeof LISTENER_SYNC_TYPES];

/** 当前阶段默认关闭 MasterChef / Staking / Farm 监听 */
export const ENABLE_MASTER_CHEF_LISTENER =
  process.env.ENABLE_MASTER_CHEF_LISTENER === 'true';
export const ENABLE_AU_STAKING_LISTENER =
  process.env.ENABLE_AU_STAKING_LISTENER === 'true';
export const ENABLE_CAT_FARM_LISTENER = process.env.ENABLE_CAT_FARM_LISTENER === 'true';
export const ENABLE_TOKEN_TRANSFER_LISTENER =
  process.env.ENABLE_TOKEN_TRANSFER_LISTENER !== 'false';

/** raw_event 处理失败最大重试次数 */
export const RAW_EVENT_MAX_RETRIES = Math.max(
  1,
  Number(process.env.RAW_EVENT_MAX_RETRIES ?? 5),
);

/** WebSocket 推送最小间隔（毫秒） */
export const WS_PRICE_UPDATE_MIN_MS = Math.max(
  500,
  Number(process.env.WS_PRICE_UPDATE_MIN_MS ?? 2000),
);
export const WS_HOLDER_UPDATE_MIN_MS = Math.max(
  500,
  Number(process.env.WS_HOLDER_UPDATE_MIN_MS ?? 1500),
);

/** @deprecated 使用 ListenerSyncType */
export type SyncLayerMode = 'idle' | 'tail' | 'backfill';
