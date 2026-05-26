import { Router } from 'express';
import {
  dbGet,
  isPostgresEnabled,
  MONITOR_WALLET,
  listContracts,
  getContract,
  listEvents,
  countEventsByType,
  listHolders,
  countByStatus,
  countPairs,
  getPairByToken,
  getPairsByTokens,
  refreshRpcStatus,
  getRpcStatus,
  getRpcManagerStatus,
  ensureRpcManagerReady,
  getTelegramStatus,
  sendTestNotification,
  getMeta,
  setMeta,
  pickBestHttpRpc,
  getHttpProvider,
  scanBlocksForDeploys,
  importToken,
  STATUS_LABELS,
  CHAIN_ID,
  loadMonitorTokens,
  isMonitoredToken,
  loadEcosystemContracts,
  loadProjectAddresses,
  getTokenMarket,
  getTokenStats24h,
  getAddressProfile,
  confirmHolderBalanceOnchain,
  listAlerts,
  getStakingStat,
  listStakingRecords,
  getLiquidityStat,
  getRiskScan,
  getOpportunity,
  listByLabel,
  scanTokenRisk,
  getTokenOverview,
  listTraders,
  listPriceSnapshots,
  listHourlyVolume,
  repairTokenHolderDatabase,
  repairAllMonitorTokenDatabases,
  listHolderRanking,
  defaultHolderRankingSort,
  getTokenLpStakingStat,
  listLpStakers,
  lpMonitoringMeta,
  rescanLpStakingAddresses,
  refreshTokenMarket,
  getMonitorToken,
  listTokenTransactions,
  listWhaleActivity,
  computeAddressGrading,
  listSyncStatus,
  listSyncFailures,
  tradePriceUsdFromEvent,
  getListenerService,
  countPendingRawEvents,
  listAlertsPendingTelegram,
  enrichTradeRowsBalanceAfter,
  normalizeTradeRow,
  listWalletRemarks,
  getWalletRemark,
  upsertWalletRemark,
  deleteWalletRemark,
  normalizeWalletRemark,
  quoteSymbol,
  fetchTokenMeta,
  fetchQuoteBalanceAfter,
  USDT,
} from '@token-monitor/shared';
import { ok, fail } from '../util/response.js';

async function getQuoteDisplayContext(tokenAddress: string): Promise<{
  quoteSymbol: string;
  quoteDecimals: number;
}> {
  const pair = await getPairByToken(tokenAddress);
  if (!pair?.quote_token) {
    return { quoteSymbol: 'USDT', quoteDecimals: 18 };
  }
  const quoteToken = String(pair.quote_token).toLowerCase();
  const sym = String(pair.quote_symbol ?? quoteSymbol(quoteToken));
  let quoteDecimals = 18;
  try {
    const provider = await getHttpProvider();
    if (provider) {
      const meta = await fetchTokenMeta(provider, quoteToken);
      if (meta?.decimals != null) quoteDecimals = meta.decimals;
    }
  } catch {
    /* default 18 */
  }
  return { quoteSymbol: sym, quoteDecimals: quoteDecimals };
}

async function enrichSwapItems(
  tokenAddress: string,
  items: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const contract = await getContract(tokenAddress);
  const dec = contract?.token_decimals ?? 18;
  return items.map((row) => {
    const priceUsd = tradePriceUsdFromEvent(
      Number(row.amount_usd ?? 0),
      String(row.token_amount ?? '0'),
      dec,
      Number(row.price ?? 0),
    );
    return { ...row, price_usd: priceUsd, price_kind: 'trade' as const };
  });
}
import { requireAuth, login, authEnabled } from '../middleware/auth.js';
import { broadcastRealtime } from '../realtime/hub.js';
import { createRpcRouter } from './rpc.js';

export function createRouter(): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'api' });
  });

  r.post('/internal/realtime', async (req, res) => {
    const body = req.body as {
      type?: string;
      tokenAddress?: string;
      data?: Record<string, unknown>;
    };
    if (!body.type || !body.tokenAddress) {
      return fail(res, 'type and tokenAddress required', 400);
    }
    const sent = broadcastRealtime({
      type: body.type,
      tokenAddress: body.tokenAddress,
      data: body.data ?? {},
    });
    ok(res, { sent });
  });

  r.get('/auth/status', (_req, res) => {
    ok(res, { required: authEnabled() });
  });

  r.post('/auth/login', async (req, res) => {
    const token = login(String(req.body?.password ?? ''));
    if (!token) return fail(res, 'Invalid password', 401);
    ok(res, { token });
  });

  r.use(requireAuth);

  r.use('/rpc', createRpcRouter());

  r.get('/system/status', async (_req, res) => {
    let dbConnected = false;
    if (isPostgresEnabled()) {
      try {
        await dbGet('SELECT 1 AS ok');
        dbConnected = true;
      } catch {
        dbConnected = false;
      }
    }
    await ensureRpcManagerReady().catch(() => undefined);
    const rpcDetail = await getRpcManagerStatus();
    const rpc = await getRpcStatus();
    const tg = getTelegramStatus();
    const statusCounts = await countByStatus();
    const chainListener = await getListenerService('chain-listener');
    const pendingRaw = await countPendingRawEvents();
    const pendingAlerts = (await listAlertsPendingTelegram(1)).length;
    const listenerHb = Number(chainListener?.heartbeat_at ?? 0);
    const listenerStale =
      listenerHb > 0 && Date.now() - listenerHb > 3 * 60_000;
    ok(res, {
      pipeline: [
        {
          service: 'chain-listener',
          status: chainListener?.status ?? (listenerHb ? 'UNKNOWN' : 'NOT_SEEN'),
          lag_blocks: chainListener?.lag_blocks ?? null,
          latest_block: chainListener?.latest_block ?? null,
          heartbeat_at: listenerHb || null,
          note: listenerStale ? 'heartbeat stale (>3m)' : 'docker compose logs chain-listener',
        },
        {
          service: 'event-processor',
          status:
            pendingRaw > 500 ? 'DEGRADED' : pendingRaw > 0 ? 'CATCHING_UP' : 'IDLE',
          pending_raw_events: pendingRaw,
          note: 'docker compose logs event-processor',
        },
        {
          service: 'alert-worker',
          status: pendingAlerts > 0 ? 'BACKLOG' : 'IDLE',
          pending_telegram_alerts: pendingAlerts,
          note: 'docker compose logs alert-worker',
        },
      ],
      rpc,
      rpcDetail,
      telegram: tg,
      database: { connected: dbConnected, engine: 'postgresql' },
      monitor_wallet: MONITOR_WALLET,
      chain_id: CHAIN_ID,
      tokens_discovered: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      pairs_created: await countPairs(),
      last_scanned_block: await getMeta('last_scanned_block'),
    });
  });

  r.post('/tokens/import', async (req, res) => {
    const address = String(req.body?.address ?? req.body?.contract_address ?? '').trim();
    const pair_address = req.body?.pair_address
      ? String(req.body.pair_address).trim()
      : undefined;
    if (!address) return fail(res, '请提供 Token 合约地址');
    try {
      await pickBestHttpRpc();
      const provider = await getHttpProvider();
      const result = await importToken(provider, { contract_address: address, pair_address });
      ok(
        res,
        {
          ...result,
          status_label: STATUS_LABELS[result.status],
          pair: await getPairByToken(result.contract.contract_address),
        },
        result.created ? 'Token 已导入' : 'Token 已更新',
      );
    } catch (e) {
      fail(res, e instanceof Error ? e.message : '导入失败', 400);
    }
  });

  r.get('/tokens', async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 20);
    const status = req.query.status as string | undefined;
    const result = await listContracts({ status, page, pageSize });
    const monitoredItems = result.items.filter((t) =>
      isMonitoredToken(t.contract_address),
    );
    const pairMap = await getPairsByTokens(monitoredItems.map((t) => t.contract_address));
    const items = monitoredItems.map((t) => ({
      ...t,
      status_label: STATUS_LABELS[t.status],
      pair: pairMap.get(t.contract_address.toLowerCase()) ?? null,
    }));
    ok(res, { items, total: monitoredItems.length, page, pageSize });
  });

  r.get('/tokens/:address', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const contract = await getContract(addr);
    if (!contract) return fail(res, 'Token not found', 404);
    const pair = await getPairByToken(addr);
    ok(res, {
      contract,
      status_label: STATUS_LABELS[contract.status],
      pair,
      event_counts: await countEventsByType(addr),
    });
  });

  r.get('/tokens/:address/overview', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const contract = await getContract(addr);
    if (!contract) return fail(res, 'Token not found', 404);
    const forceRefresh = String(req.query.refresh ?? '') === '1';
    const market = await getTokenMarket(addr);
    const staleMs = Date.now() - (market?.updatedAt ?? 0);
    if (forceRefresh) {
      try {
        await pickBestHttpRpc();
        await refreshTokenMarket(await getHttpProvider(), addr);
      } catch {
        /* 仍返回缓存价格 */
      }
    } else if (!market || staleMs > 45_000) {
      void (async () => {
        try {
          await pickBestHttpRpc();
          await refreshTokenMarket(await getHttpProvider(), addr);
        } catch {
          /* 后台刷新失败仍返回缓存 */
        }
      })();
    }
    const overview = await getTokenOverview(addr);
    const pair = await getPairByToken(addr);
    ok(res, {
      contract,
      status_label: STATUS_LABELS[contract.status],
      pair,
      overview,
    });
  });

  r.get('/tokens/:address/trades', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 100);
    const event_type = req.query.type as string | undefined;
    const trader = (req.query.address as string) || undefined;
    const { items, total } = await listEvents(addr, { event_type, trader, page, pageSize });
    ok(res, {
      items: await enrichSwapItems(addr, items),
      total,
      page,
      pageSize,
    });
  });

  r.get('/tokens/:address/swaps', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 100);
    const trader =
      (req.query.address as string) ||
      (req.query.wallet as string) ||
      undefined;
    const type = req.query.type as string | undefined;
    const types =
      type === 'buy' || type === 'sell' ? [type] : (['buy', 'sell'] as const);

    const txResult = await listTokenTransactions(addr, {
      trade_types: [...types],
      wallet: trader,
      page,
      pageSize,
    });
    if (txResult.total > 0) {
      const items = enrichTradeRowsBalanceAfter(
        txResult.items.map((row) => ({
          id: `${row.tx_hash}-${row.log_index}`,
          event_time: row.block_time,
          event_type: row.trade_type,
          trader: row.wallet_address,
          wallet_address: row.wallet_address,
          address_type: row.address_type,
          is_contract: row.is_contract,
          token_amount: row.token_amount,
          quote_amount: row.quote_amount,
          amount_usd: row.amount_usd,
          price: row.price,
          balance_after: row.balance_after,
          quote_balance_after: row.quote_balance_after,
          buy_count_after: row.buy_count_after,
          sell_count_after: row.sell_count_after,
          tx_hash: row.tx_hash,
          block_number: row.block_number,
          block_time: row.block_time,
          log_index: row.log_index,
          trade_type: row.trade_type,
          side: row.side,
        })),
      ).map((row) => ({
        id: row.id,
        event_time: row.event_time,
        event_type: row.event_type,
        trader: row.trader,
        address_type: row.address_type,
        is_contract: row.is_contract,
        token_amount: row.token_amount,
        quote_amount: row.quote_amount,
        amount_usd: row.amount_usd,
        price: row.price,
        balance_after: row.balance_after,
        quote_balance_after: row.quote_balance_after,
        buy_count_after: row.buy_count_after,
        sell_count_after: row.sell_count_after,
        tx_hash: row.tx_hash,
        block_number: row.block_number,
        side: row.side,
      }));
      const quoteCtx = await getQuoteDisplayContext(addr);
      ok(res, {
        items: await enrichSwapItems(addr, items),
        total: txResult.total,
        page,
        pageSize,
        ...quoteCtx,
      });
      return;
    }

    const { items, total } = await listEvents(addr, {
      event_types: [...types],
      trader,
      page,
      pageSize,
    });
    const quoteCtx = await getQuoteDisplayContext(addr);
    ok(res, {
      items: await enrichSwapItems(addr, items.map(normalizeTradeRow)),
      total,
      page,
      pageSize,
      ...quoteCtx,
    });
  });

  r.get('/tokens/:address/transfers', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 100);
    const trader = (req.query.address as string) || undefined;
    const { items, total } = await listEvents(addr, {
      event_type: 'transfer',
      trader,
      page,
      pageSize,
    });
    ok(res, { items, total, page, pageSize });
  });

  r.get('/tokens/:address/traders', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 100);
    const contract = await getContract(addr);
    const { items, total } = await listTraders(addr, { page, pageSize });
    ok(res, {
      items,
      total,
      page,
      pageSize,
      decimals: contract?.token_decimals ?? 18,
    });
  });

  r.get('/tokens/:address/holders', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const page = Number(req.query.page ?? 1);
    const pageSize = Math.min(100, Number(req.query.pageSize ?? 50));
    const contract = await getContract(addr);
    const { items, total } = await listHolders(addr, { page, pageSize });
    ok(res, {
      items,
      total,
      page,
      pageSize,
      decimals: contract?.token_decimals ?? 18,
    });
  });

  r.get('/tokens/:address/holder-ranking', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const page = Number(req.query.page ?? 1);
    const pageSize = Math.min(100, Number(req.query.pageSize ?? 50));
    const filter = String(req.query.filter ?? 'all');
    const allowed = [
      'all',
      'whale',
      'super_whale',
      'accumulating',
      'reducing',
      'staking',
      'lp_staking',
      'cleared',
      'new_buy',
    ];
    const f = allowed.includes(filter) ? filter : 'all';
    const sortAllowed = [
      'holding_usd',
      'balance',
      'buy_count',
      'sell_count',
      'net_buy',
      'last_trade_time',
    ] as const;
    const orderRaw = String(req.query.order ?? 'desc').toLowerCase();
    const sortDir = orderRaw === 'asc' ? 'asc' : 'desc';
    const sortRaw = String(req.query.sort ?? '');
    const defaults = await defaultHolderRankingSort(addr);
    const sortBy = sortAllowed.includes(sortRaw as (typeof sortAllowed)[number])
      ? (sortRaw as (typeof sortAllowed)[number])
      : defaults.sortBy;
    const contract = await getContract(addr);
    const { items, total, sortBy: appliedSort, sortDir: appliedDir, hasMarket } =
      await listHolderRanking(addr, {
        filter: f as import('@token-monitor/shared').HolderRankingFilter,
        page,
        pageSize,
        sortBy,
        sortDir,
      });
    const lpStat = await getTokenLpStakingStat(addr);
    const lpMeta = lpMonitoringMeta(getMonitorToken(addr));
    ok(res, {
      items,
      total,
      page,
      pageSize,
      filter: f,
      sort: appliedSort,
      order: appliedDir,
      hasMarket,
      lpMonitoring: lpMeta,
      lpStakingStat: lpStat,
      decimals: contract?.token_decimals ?? 18,
    });
  });

  r.get('/tokens/:address/whale-activity', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const limit = Number(req.query.limit ?? 80);
    const sinceHours = Number(req.query.sinceHours ?? 24);
    const sinceMs = Number.isFinite(sinceHours) ? sinceHours * 60 * 60_000 : 24 * 60 * 60_000;
    const { items, total } = await listWhaleActivity(addr, {
      limit: Number.isFinite(limit) ? limit : 80,
      sinceMs,
    });
    const contract = await getContract(addr);
    ok(res, { items, total, decimals: contract?.token_decimals ?? 18 });
  });

  r.post('/tokens/:address/holders/sync', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const contract = await getContract(addr);
    if (!contract) return fail(res, '未找到该 Token');
    try {
      const provider = await getHttpProvider();
      const result = await repairTokenHolderDatabase(provider, addr, {
        forceBackfill: req.body?.force === true,
      });
      ok(
        res,
        result,
        `已修复 ${result.symbol}：${result.holders_synced} 持仓，${result.profiles_rebuilt} 条汇总`,
      );
    } catch (e) {
      fail(res, e instanceof Error ? e.message : '持仓同步失败');
    }
  });

  r.post('/admin/holders/repair-all', async (req, res) => {
    try {
      const provider = await getHttpProvider();
      const results = await repairAllMonitorTokenDatabases(provider, {
        forceBackfill: req.body?.force === true,
      });
      ok(res, { results }, `已修复 ${results.length} 个监控 Token`);
    } catch (e) {
      fail(res, e instanceof Error ? e.message : '批量修复失败');
    }
  });

  r.post('/notify/test', async (_req, res) => {
    const sent = await sendTestNotification();
    ok(res, { sent }, sent ? '测试消息已发送' : '发送失败，请检查 Telegram 配置');
  });

  r.post('/scan', async (req, res) => {
    const wallet = String(req.body?.walletAddress ?? MONITOR_WALLET).toLowerCase();
    const fromBlock = Number(req.body?.fromBlock);
    const toBlock = Number(req.body?.toBlock);
    if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock)) {
      return fail(res, 'fromBlock and toBlock required');
    }
    if (toBlock - fromBlock > 5000) {
      return fail(res, '单次最多扫描 5000 个区块');
    }
    if (wallet !== MONITOR_WALLET) {
      return fail(res, 'walletAddress must match MONITOR_WALLET');
    }
    await setMeta('scan_pending', JSON.stringify({ fromBlock, toBlock, at: Date.now() }));
    try {
      await pickBestHttpRpc();
      const provider = await getHttpProvider();
      const result = await scanBlocksForDeploys(provider, fromBlock, toBlock);
      ok(res, { fromBlock, toBlock, ...result }, '扫描完成');
    } catch (e) {
      fail(res, e instanceof Error ? e.message : 'scan failed', 500);
    }
  });

  r.get('/monitor/tokens', (_req, res) => {
    ok(res, { tokens: loadMonitorTokens() });
  });

  r.get('/ecosystem/contracts', (_req, res) => {
    ok(res, {
      ecosystem: loadEcosystemContracts(),
      projectAddresses: loadProjectAddresses(),
    });
  });

  r.get('/tokens/:address/sync-status', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    ok(res, { items: await listSyncStatus(addr) });
  });

  r.get('/tokens/:address/sync-failures', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    ok(res, { items: await listSyncFailures(addr) });
  });

  r.post('/tokens/:address/sync/history', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    await setMeta(`history_sync:${addr}`, '');
    if (req.body?.force) await setMeta(`history_sync_force:${addr}`, '1');
    ok(res, { queued: true }, '历史区块同步已排队，Worker 将按 startBlock 执行');
  });

  r.get('/tokens/:address/chart', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const range = String(req.query.range ?? '24h');
    const ms =
      range === '1h'
        ? 60 * 60_000
        : range === '7d'
          ? 7 * 24 * 60 * 60_000
          : 24 * 60 * 60_000;
    const since = Date.now() - ms;
    ok(res, {
      range,
      price: await listPriceSnapshots(addr, since),
      volume: await listHourlyVolume(addr, since),
    });
  });

  r.get('/tokens/:address/market', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const market = await getTokenMarket(addr);
    const stats24h = await getTokenStats24h(addr);
    ok(res, { market, stats24h });
  });

  r.get('/tokens/:address/wallet-remarks', async (req, res) => {
    const token = req.params.address.toLowerCase();
    ok(res, { items: await listWalletRemarks(token) });
  });

  r.put('/tokens/:address/addresses/:wallet/remark', async (req, res) => {
    const token = req.params.address.toLowerCase();
    const wallet = req.params.wallet.toLowerCase();
    const remark = normalizeWalletRemark(String(req.body?.remark ?? ''));
    if (!remark) return fail(res, '备注不能为空', 400);
    await upsertWalletRemark(token, wallet, remark);
    ok(res, { wallet_address: wallet, remark }, '备注已保存');
  });

  r.delete('/tokens/:address/addresses/:wallet/remark', async (req, res) => {
    const token = req.params.address.toLowerCase();
    const wallet = req.params.wallet.toLowerCase();
    const removed = await deleteWalletRemark(token, wallet);
    if (!removed) return fail(res, '备注不存在', 404);
    ok(res, { wallet_address: wallet }, '备注已删除');
  });

  r.get('/tokens/:address/addresses/:wallet', async (req, res) => {
    const token = req.params.address.toLowerCase();
    const wallet = req.params.wallet.toLowerCase();
    const market = await getTokenMarket(token);
    const contract = await getContract(token);
    const provider = await getHttpProvider();
    let onchainBalance: { balance: string; balanceSource: string } | null = null;
    let usdtBalance: string | null = null;
    if (provider) {
      try {
        onchainBalance = await confirmHolderBalanceOnchain(provider, token, wallet);
      } catch {
        onchainBalance = null;
      }
      try {
        usdtBalance = await fetchQuoteBalanceAfter(provider, USDT, wallet);
      } catch {
        usdtBalance = null;
      }
    }
    const profile = await getAddressProfile(
      token,
      wallet,
      market?.priceUsd ?? 0,
      contract?.token_decimals ?? 18,
    );
    if (!profile) return fail(res, 'Address not found for token', 404);
    const txResult = await listTokenTransactions(token, {
      wallet,
      trade_types: ['buy', 'sell'],
      pageSize: 100,
    });
    let trades: Record<string, unknown>[] = txResult.items.map(normalizeTradeRow);
    if (txResult.total === 0) {
      const ev = await listEvents(token, {
        trader: wallet,
        event_types: ['buy', 'sell'],
        pageSize: 100,
      });
      trades = ev.items.map(normalizeTradeRow);
    }
    const grading = computeAddressGrading(
      token,
      wallet,
      market?.priceUsd ?? 0,
      market?.liquidityUsd ?? 0,
      contract?.token_decimals ?? 18,
    );
    const remark = await getWalletRemark(token, wallet);
    const quoteCtx = await getQuoteDisplayContext(token);
    ok(res, {
      profile: {
        ...profile,
        ...(onchainBalance
          ? {
              walletBalance: onchainBalance.balance,
              balanceSource: onchainBalance.balanceSource,
            }
          : {}),
        ...(usdtBalance != null ? { usdtBalance } : {}),
      },
      remark,
      trades,
      grading,
      onchainBalance,
      ...quoteCtx,
    });
  });

  r.get('/tokens/:address/staking', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const stat = await getStakingStat(addr);
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    const records = await listStakingRecords(addr, { page, pageSize });
    const lpStat = await getTokenLpStakingStat(addr);
    const lpMeta = lpMonitoringMeta(getMonitorToken(addr));
    const lpStakers = lpMeta
      ? await listLpStakers(addr, { page, pageSize, forceReconcile: true })
      : null;
    ok(res, {
      stat,
      ...records,
      page,
      pageSize,
      lpMonitoring: lpMeta,
      lpStakingStat: lpStat,
      lpStakers,
    });
  });

  r.post('/tokens/:address/staking/rescan', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    if (!lpMonitoringMeta(getMonitorToken(addr))) {
      return fail(res, '该代币未配置 LP 质押监控');
    }
    try {
      await pickBestHttpRpc();
      const provider = await getHttpProvider();
      if (!provider) return fail(res, 'RPC 不可用');
      const fromBlock =
        req.body?.fromBlock != null ? Number(req.body.fromBlock) : undefined;
      const result = await rescanLpStakingAddresses(provider, addr, {
        fromBlock: Number.isFinite(fromBlock) ? fromBlock : undefined,
        autoDetectFromBlock: req.body?.autoDetectFromBlock !== false,
        purgeRecords: req.body?.purgeRecords !== false,
      });
      ok(
        res,
        result,
        `已重扫 LP 质押：${result.walletsDiscovered} 个地址，${result.recordsInserted} 条流水`,
      );
    } catch (e) {
      fail(res, e instanceof Error ? e.message : 'LP 质押重扫失败');
    }
  });

  r.get('/tokens/:address/liquidity', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    ok(res, { liquidity: await getLiquidityStat(addr), market: await getTokenMarket(addr) });
  });

  r.get('/tokens/:address/whales', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    const filter = String(req.query.filter ?? 'whale');
    const pageSize = Number(req.query.limit ?? 200);
    const whaleFilter =
      filter === 'all' || filter === 'super_whale' ? filter : 'whale';
    const { items, total } = await listHolderRanking(addr, {
      filter: whaleFilter as import('@token-monitor/shared').HolderRankingFilter,
      page: 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 200,
    });
    ok(res, { items, total });
  });

  r.get('/tokens/:address/opportunity', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    ok(res, { opportunity: await getOpportunity(addr) });
  });

  r.get('/tokens/:address/risk', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    ok(res, { risk: await getRiskScan(addr) });
  });

  r.post('/tokens/:address/risk/scan', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    try {
      await pickBestHttpRpc();
      const provider = await getHttpProvider();
      const risk = await scanTokenRisk(provider, addr);
      ok(res, { risk }, '风险扫描完成');
    } catch (e) {
      fail(res, e instanceof Error ? e.message : 'scan failed', 500);
    }
  });

  r.get('/tokens/:address/smart-money', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    ok(res, { items: await listByLabel(addr, 'smart_money', 50) });
  });

  r.get('/tokens/:address/bots', async (req, res) => {
    const addr = req.params.address.toLowerCase();
    ok(res, { items: await listByLabel(addr, 'bot', 50) });
  });

  r.get('/alerts', async (req, res) => {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 50);
    const token_address = req.query.token as string | undefined;
    const result = await listAlerts({ token_address, page, pageSize });
    ok(res, { ...result, page, pageSize });
  });

  // Dashboard aggregate
  r.get('/dashboard', async (_req, res) => {
    const { items } = await listContracts({ pageSize: 5 });
    const pairMap = await getPairsByTokens(items.map((t) => t.contract_address));
    const statusCounts = await countByStatus();
    const rpc = await getRpcStatus();
    const tg = getTelegramStatus();
    ok(res, {
      monitor_wallet: MONITOR_WALLET,
      token_counts: statusCounts,
      pairs_count: await countPairs(),
      latest_tokens: items.map((t) => ({
        ...t,
        status_label: STATUS_LABELS[t.status],
        pair: pairMap.get(t.contract_address.toLowerCase()) ?? null,
      })),
      rpc,
      telegram: tg,
      last_scanned_block: await getMeta('last_scanned_block'),
    });
  });

  return r;
}
