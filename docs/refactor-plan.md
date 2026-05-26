# 重构与性能优化计划

> 原则：稳定性优先；不改业务逻辑、API 结构、DB schema、ABI、精度/收益计算、安全校验。

## 项目结构（当前生产路径）

```
chain-listener → raw_events (pending)
  → event-processor → token_event / holder / stat / alert_log
  → alert-worker → Telegram
backend (API + WS) ← 只读 DB
frontend
shared（核心库）
```

## 主要优化点（按优先级）

| 优先级 | 类别 | 问题 | 影响 |
|--------|------|------|------|
| P0 | DB | 每条 Transfer/LP 事件 `COUNT(*)` pending | 积压时 processor 极慢 |
| P0 | RPC | 事件热路径 `syncWalletLpBalances` → 全链 getLogs | 429 限流、阻塞 Swap |
| P1 | DB | 单笔 Swap：stat/holder/market 在 pipeline/profile/alert 重复查 | 3～6 次冗余查询/笔 |
| P1 | RPC | `layeredListeners` 同轮两次 `getBlockNumber` | 监听 lag 放大 |
| P2 | RPC | LP staking getLogs 未走全局限流 | 与 listener 抢 RPC |
| P2 | 结构 | lag 告警口径（DB 字段 vs chain head 重算） | 误报/漏报 |
| P3 | 重复 | ~~worker/ 与 chain-listener 双轨~~（已清理） | — |
| P3 | 死代码 | `shared/src/db/schema.ts` SQLite 已废弃 | 误导阅读 |

## 分模块计划

### 模块 1：event-processor 热路径 ✅
- 批次级 `pendingBacklog`，去掉 per-event `countPendingRawEvents`
- `recordTransfer` / farm 事件用 `allowLpSync` 标志
- `event-processor` 每轮 batch 优化 COUNT
- `tickDataMaintenance` 传递已知 pending

### 模块 2：chain-listener RPC ✅
- `resolveChainHead()` 统一获取链头，同轮 scan 不再重复 `getBlockNumber`
- `retryLayeredFailedChunks` 批内共用 head
- `loadTokenCtx` 60s TTL 内存缓存（`LISTENER_TOKEN_CTX_TTL_MS`）

### 模块 3：Swap 链路 DB 合并 ✅
- `applyEventToStat` 更新后返回 stat 行（+1 查，下游少 3～4 查）
- `finalizeChainTransaction` / `enrichRealtimeTradePayload` / `maybeAlertLargeTrade` 支持可选上下文
- `recordSwap` 一次加载 contract/market，贯穿 pipeline

### 模块 4：LP staking RPC ✅
- `fetchStakeTransferLogs` 改用 `fetchLogsBatched`（接入 `acquireGetLogsSlot` + RPC 退避）
- `retryLpStakingFailedChunks` 同样走 `fetchLogsBatched`
- 默认扫描窗口 `LP_SYNC_DEFAULT_BLOCK_RANGE`（2000 块，可 env 配置）
- 事件热路径 `LP_EVENT_SYNC_BLOCK_RANGE`（替代硬编码 8000）
- deposit/withdraw 两次 getLogs 改为串行，降低并发 RPC 压力
- 维护路径（`calibrateTokenLpBalances` / `syncLpStakingWatchWallets`）仍用 8000+ 块宽窗口

### 模块 5：可维护性 ✅（worker 遗留已清理）
- [x] 删除 `worker/` 与 `docker/Dockerfile.worker`
- [x] 更新 README / requirements / `/system/status` pipeline 字段
- [ ] 删除 `shared/src/db/schema.ts` SQLite 层（确认无引用）
- [ ] 拆分 `backend/routes/index.ts`（仅文件移动，路由不变）
- [ ] 服务 bootstrap 抽公共 `ensureServiceReady()`（无行为变化）

## 验收标准（每模块）

1. `npm run build` 全 workspace 通过
2. `raw_events` pending 可正常消化
3. CAT 买卖仍写入 `token_event`，TG 格式不变
4. API `/tokens/:address/trades` 响应结构不变

## 待用户确认（不自动删除）

1. **`shared/src/db/schema.ts`**：是否可移除 SQLite 遗留层？
