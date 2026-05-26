# BSC Token 监控面板

个人使用的 BSC Token 链上监控：部署发现、LP 创建 Telegram 提醒、交易与持仓面板。

需求文档见 [docs/token-monitor-requirements.md](docs/token-monitor-requirements.md)。

## 快速开始

```bash
cp .env.example .env
# 编辑 .env：AUTH_PASSWORD、TELEGRAM_*、RPC 等

# Docker（推荐）
docker compose up -d --build
open http://localhost:8080

# 本地开发
npm install
npm run dev
```

- 前端：http://localhost:5173（开发） / http://localhost:8080（Docker）
- API：http://localhost:3001/api/v1/health

## 生产链路

```text
chain-listener → raw_events → event-processor → alert-worker → Telegram
backend (API + WS) ← 只读 DB
frontend
```

## 结构

```text
frontend/  backend/  shared/
chain-listener/  event-processor/  alert-worker/
data/  docker/  docs/
```

## 验证

```bash
docker compose ps
curl http://localhost:8080/api/v1/health
docker compose logs --tail=50 chain-listener
docker compose logs --tail=50 event-processor
docker compose logs --tail=50 alert-worker
```
