# Token 链上监控面板需求文档

## 1. 项目目标

本项目是一个个人使用的 BSC Token 链上监控面板。

核心目标：

1. 监控指定钱包地址是否部署新的 Token 合约；
2. 发现 Token 后，自动识别 Token 基础信息；
3. 在 Token 未创建 LP 前，监听 Transfer 事件和持仓变化；
4. 监听 PancakeSwap Factory 的 PairCreated 事件；
5. 当 Token 创建 LP 时，自动发送 Telegram 提醒；
6. LP 创建后，开始监听买入、卖出、添加流动性、移除流动性；
7. 在前端面板展示 Token 状态、交易记录、持仓地址、交易量和系统状态；
8. 使用 Docker Compose 一键启动，适合个人单机部署。

---

## 2. 当前项目结构

当前项目应保持以下结构：

```text
bsc-token-monitor/
├── frontend/           # 前端页面
├── backend/            # 后端 API
├── chain-listener/     # 链上监听 → raw_events
├── event-processor/    # 消费 raw_events → 业务表
├── alert-worker/       # 消费 alert_log → Telegram
├── shared/             # 公共类型、常量、工具函数
├── data/               # 配置与持久化数据（PostgreSQL 由 compose 管理）
├── docker/             # Docker / Nginx 配置
├── docs/               # 项目文档
├── .env                # 本地环境变量，不提交
├── .env.example        # 环境变量模板
├── docker-compose.yml  # 一键启动配置
└── README.md
```

生产数据流：

```text
chain-listener → raw_events → event-processor → alert-worker → Telegram
```

要求：

- frontend 只负责页面展示和 API 调用；
- backend 只负责接口、数据库读取和业务查询；
- chain-listener 只负责链上事件采集并写入 `raw_events`；
- event-processor 负责解析事件、更新持仓/统计并写入告警队列；
- alert-worker 负责 Telegram 等告警投递；
- shared 只放真正被多个模块共用的类型、常量、工具函数；
- 不要把 Bot Token、私钥、RPC Key 等敏感信息写死到代码里。

---

## 3. Token 生命周期状态

Token 状态分为 3 个阶段：

```text
deployed_no_liquidity    已部署，未创建流动性
liquidity_created        已创建流动性，等待交易
trading_started          已开始交易
```

前端显示文案：

| 状态 | 前端文案 |
| --- | --- |
| deployed_no_liquidity | Token 已部署，正在等待创建流动性 |
| liquidity_created | LP 已创建，正在等待交易 |
| trading_started | 已开始交易，监控中 |

注意：

- Token 未创建 LP 时，不应该显示为错误；
- 没有交易数据时，页面应显示「Token 已部署，正在等待创建流动性」；
- 只有创建 LP 后，才开始监听 Swap 买卖事件。

---

## 4. 核心业务流程

### 4.1 监控地址部署 Token

系统需要监控指定钱包地址：

```text
0xe45C0199A65f55CE2EfbB865025A52b3C75440BC
```

当该地址发起合约部署交易时：

```text
tx.to == null
receipt.contractAddress != null
```

系统需要：

1. 获取新合约地址；
2. 调用 ERC20 / BEP20 标准方法：name()、symbol()、decimals()、totalSupply()、balanceOf(address)；
3. 如果以上核心方法可正常返回，则标记为 Token；
4. 写入 deployed_contract 表；
5. Token 状态设置为 deployed_no_liquidity。

### 4.2 Token 未创建 LP 阶段

当 Token 只是部署出来，但还没有创建 LP 时，系统需要监听：

1. Token 合约 Transfer 事件；
2. PancakeSwap Factory PairCreated 事件。

此阶段需要记录：

- 普通转账；
- 部署者分发 Token；
- Token 转入其他地址；
- 当前 holder 持仓变化。

注意：

- 普通 Transfer 不能当成买入或卖出；
- 没有 Pair 地址时，不能解析 buy / sell；
- 页面要明确显示「正在等待创建流动性」。

### 4.3 LP 创建监听

监听 PancakeSwap Factory 的 PairCreated 事件：

```solidity
PairCreated(address indexed token0, address indexed token1, address pair, uint)
```

如果 token0 或 token1 等于目标 Token，则说明该 Token 创建了 LP。

系统需要：

1. 记录 Pair 地址；
2. 记录 token0、token1；
3. 判断 Quote Token；
4. 更新 Token 状态为 liquidity_created；
5. 发送 Telegram 通知；
6. 开始监听 Pair 的 Swap / Mint / Burn / Sync 事件。

### 4.4 LP 创建后交易监听

LP 创建后，监听 Pair 事件：Swap、Mint、Burn、Sync、Transfer。

并解析为：buy、sell、add_liquidity、remove_liquidity、transfer。

当出现第一笔 Swap 后，将 Token 状态更新为 trading_started。

---

## 5. Telegram 通知需求

### 5.1 环境变量

`.env` 中配置：

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TG_NOTIFY_ENABLED=true
TG_NOTIFY_LP_CREATED=true
```

要求：

- Bot Token 只能从 .env 读取；
- 不允许写死在代码中；
- 前端不能展示完整 Bot Token；
- Telegram 发送失败不能影响链上监听与事件处理服务正常运行。

### 5.2 LP 创建通知格式

当 Token 创建 LP 后，发送 Telegram 消息。消息格式必须精简：

```text
🚨 LP 已创建

Token: 0xcab...14fb
Pair: 0x123...7890
Quote: USDT

Tx:
https://bscscan.com/tx/0x...

Time: 2026/5/17 17:46

交易监控已启动。
```

不要展示：token0、token1、Block、过长 Quote 组合、调试字段、无用日志。

### 5.3 测试通知接口

后端提供 `POST /api/v1/notify/test`，调用后发送测试消息：`Telegram 通知测试成功。`

---

## 6. 前端页面需求

### 6.1 Dashboard 总览页

展示：监控钱包、发现 Token 数、已创建 LP 数、已开始交易 Token 数、最新 Token、最新 LP 记录、Worker 状态、RPC 状态、Telegram 通知状态。

### 6.2 Token 列表页

字段：Token、Name、Status、Pair、Quote、Deployed Time、LP Created Time、Action。

### 6.3 Token 详情页

展示：Token 基础信息、部署信息、状态、Pair、Quote、价格、流动性、交易统计、最新交易、最新 Transfer、Holder 列表。

### 6.4 交易列表页

类型：transfer、buy、sell、add_liquidity、remove_liquidity。

字段：Time、Type、Address、Token Amount、Quote Amount、Price、Tx（BscScan 链接）。

要求：分页、按类型筛选、按地址搜索、地址缩短显示。

### 6.5 Holder 列表页

字段：Address、Balance、Percent、Buy Count、Sell Count、Total Buy、Total Sell、Cleared、Last Active。

### 6.6 系统配置页

展示：监控钱包、当前 RPC、延迟、最新区块、Telegram 开关、Chat ID 是否存在、LP 提醒开关、测试通知按钮、手动扫描区块入口。

注意：不要展示完整 TELEGRAM_BOT_TOKEN；若展示仅脱敏，例如 `8950...plU`。

---

## 7. 后端 API 需求

### 7.1 健康检查

`GET /api/v1/health` → `{ "ok": true, "service": "api" }`

### 7.2 获取系统状态

`GET /api/v1/system/status` → pipeline（chain-listener / event-processor / alert-worker）、RPC、延迟、最新区块、Telegram、数据库、监听钱包。

### 7.3 导入 Token

`POST /api/v1/tokens/import`

```json
{
  "address": "0x...",
  "pair_address": "0x..."
}
```

- `pair_address` 可选；留空时在 PancakeSwap Factory 上自动匹配 USDT/WBNB/BUSD 池子
- 已存在则更新元数据与状态
- 导入后 chain-listener 会通过分层同步与 WSS 部署扫描继续跟踪该 Token

### 7.4 获取 Token 列表

`GET /api/v1/tokens`，参数：status、page、pageSize。

### 7.4 获取 Token 详情

`GET /api/v1/tokens/:address`

### 7.5 获取 Token 交易记录

`GET /api/v1/tokens/:address/trades`，参数：type、page、pageSize、address。

### 7.6 获取 Token Holder 列表

`GET /api/v1/tokens/:address/holders`

### 7.7 测试 Telegram 通知

`POST /api/v1/notify/test`

### 7.8 手动扫描历史区块

`POST /api/v1/scan`，body：`{ "walletAddress", "fromBlock", "toBlock" }`，单次最多 5000 区块。

统一返回格式：

```json
{ "ok": true, "data": {}, "message": "" }
```

错误返回：

```json
{ "ok": false, "error": "error message" }
```

---

## 8. 数据库表设计

### 8.1 monitor_wallet

监控钱包表：id、chain_id、wallet_address、remark、enabled、created_at、updated_at。

### 8.2 deployed_contract

部署合约表：id、chain_id、deployer_address、contract_address、tx_hash、block_number、deploy_time、is_token、token_name、token_symbol、token_decimals、total_supply、status。

### 8.3 token_pair

流动性池表：id、chain_id、token_address、pair_address、token0、token1、quote_token、quote_symbol、dex_name、created_tx_hash、created_block、created_at。

### 8.4 token_event

Token 事件表：id、chain_id、token_address、event_type、tx_hash、block_number、event_time、from_address、to_address、trader、token_amount、quote_amount、price、pair_address。

### 8.5 token_holder

持仓表：id、chain_id、token_address、holder_address、balance、balance_percent、last_active_time、address_tag。

### 8.6 token_address_stat

地址统计表：id、chain_id、token_address、wallet_address、buy_count、sell_count、transfer_in_count、transfer_out_count、total_buy_token、total_sell_token、total_buy_value、total_sell_value、current_balance、is_cleared、last_trade_time。

### 8.7 alert_log

提醒记录表：id、alert_type、token_address、pair_address、tx_hash、message、channel、send_status、created_at。

---

## 9. RPC 监控需求

展示：current_rpc、latency、latest_block、status（good / normal / slow / error）、checked_at。

延迟判断：

```text
< 300ms       good
300-800ms     normal
800-1500ms    slow_but_usable
> 1500ms      slow
> 3000ms      error_or_switch
```

支持多 RPC：BSC_RPC_URL、BSC_RPC_BACKUP_1、BSC_RPC_BACKUP_2。各服务启动时测延迟、自动选最低延迟可用节点、失败自动切换。

---

## 10. 服务日志需求

**chain-listener**：启动、RPC 连接、分层同步 lag、心跳（head / last scanned）。

**event-processor**：启动、`raw_events` pending 消化、维护任务。

**alert-worker**：启动、Telegram 开关、发送成功/失败计数。

LP 创建时：LP created、Token、Pair、Quote、Tx、Telegram notify sent。

错误需明确：RPC error、DB error、Telegram send failed、Event parse failed。

---

## 11. 环境变量需求

`.env.example` 至少包含：AUTH_PASSWORD、WEB_PORT、API_PORT、CHAIN_ID、BSC_RPC_URL、BSC_RPC_BACKUP_*、MONITOR_WALLET、PANCAKE_FACTORY_ADDRESS、PANCAKE_ROUTER_ADDRESS、DATABASE_PATH、TELEGRAM_*、TG_NOTIFY_*。

---

## 12. Docker 部署需求

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f chain-listener
docker compose logs -f event-processor
docker compose logs -f alert-worker
docker compose logs -f api
docker compose down
```

服务：postgres、redis、api、chain-listener、event-processor、alert-worker、web。要求 health 可访问、web 8080、监听与处理链路正常、PostgreSQL 持久化、重启不丢数据。

---

## 13. 代码重构与优化要求

目标：删无用/重复代码、优化职责、保留已实现功能、不破坏 Docker。

### 13.1 全局清理

删除前先列出：准备删除的文件、删除原因、是否有引用、风险。不要直接大面积删除。

### 13.2 前端优化

只负责展示；API 统一封装；地址/Hash 统一格式；分页；状态文案统一；不展示完整 Bot Token。

### 13.3 后端优化

统一返回与错误处理；清理无用 API；分页；避免一次性返回全部数据。

### 13.4 Worker 优化

职责清晰；无 LP 不报错；失败重试；RPC 失败不退出；Telegram 失败不影响主流程；避免重复入库；心跳与 last scanned block；重启可续扫。

### 13.5 配置优化

补全 .env.example、README；data 持久化；不提交 .env 与 SQLite 数据。

---

## 14. MVP 第一阶段必须保留的功能

1. Docker Compose 启动；
2. 前端 http://localhost:8080；
3. 后端 /api/v1/health；
4. Worker 正常启动；
5. 监控指定钱包；
6. 识别 Token 部署；
7. Token 未创建 LP 状态；
8. 监听 LP 创建；
9. LP 创建 Telegram 通知；
10. 测试通知接口；
11. Token 列表；
12. Token 详情；
13. 交易记录；
14. Holder 列表；
15. SQLite 数据持久化。

---

## 15. 当前阶段不需要做的功能

多用户权限、K8s、Redis、消息队列、精确盈亏、K 线、机器人识别、地址关联、多链、大规模商业化架构。

---

## 16. 后续增强功能

第一笔交易通知、大额买卖、LP 移除、大户清仓、盈亏统计、持仓分布、交易量趋势、多 RPC、日报等。

---

## 17. 交付要求

### 第一步：只分析，不修改

先输出：

1. 当前项目结构分析；
2. 当前已实现功能；
3. 当前冗余代码；
4. 准备删除的文件清单；
5. 准备优化的模块；
6. 潜在风险点。

### 第二步：确认后再修改

确认后按模块逐步修改：shared → chain-listener / event-processor / alert-worker → backend → frontend → docker → docs。

### 第三步：修改后验证

每轮修改后验证：

```bash
docker compose up -d --build
docker compose ps
curl http://localhost:8080/api/v1/health
```

前端：http://localhost:8080 可打开。

链路服务：`docker compose logs --tail=100 chain-listener event-processor alert-worker`，不得出现 RPC 循环报错、DB error、Telegram 配置读取失败、服务启动失败。
