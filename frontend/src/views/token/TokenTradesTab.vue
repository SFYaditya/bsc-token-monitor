<script setup lang="ts">
import { computed, onActivated, ref, watch } from 'vue';
import { api } from '../../api/client';
import { useTokenPage } from '../../composables/useTokenPage';
import { useRealtime } from '../../composables/useRealtime';
import { useWalletRemarks } from '../../composables/useWalletRemarks';
import { fmtTimeShort, fmtUsd, fmtTokenAmount, fmtPrice, bscTx } from '../../utils/format';
import { tradeSizeLabel, tradeSizeBadgeClass } from '../../utils/tradeSize';
import { UI } from '../../utils/locale';
import { enrichSwapRowsBalanceAfter } from '../../utils/tradeBalance';
import DataTable from '../../components/ui/DataTable.vue';
import CopyAddr from '../../components/ui/CopyAddr.vue';
import AddressTypeBadge from '../../components/ui/AddressTypeBadge.vue';

const PAGE_SIZE = 20;

const { addr, refreshAt, decimals } = useTokenPage();
const { labelFor } = useWalletRemarks(addr);
const swaps = ref<Record<string, unknown>[]>([]);
const filterType = ref('');
const total = ref(0);
const currentPage = ref(1);
const maxLoadedPage = ref(1);
const loading = ref(false);
const loadingMore = ref(false);
const quoteSymbol = ref('USDT');
const quoteDecimals = ref(18);

const quoteBalanceLabel = computed(() => `交易后 ${quoteSymbol.value}`);
const totalPages = computed(() => Math.max(1, Math.ceil(total.value / PAGE_SIZE)));
const hasMore = computed(() => swaps.value.length < total.value);

function rowKey(row: Record<string, unknown>): string {
  return String(row.id ?? `${row.tx_hash}-${row.log_index ?? 0}`);
}

function mapApiRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id ?? `${row.tx_hash}-${row.log_index ?? 0}`,
    event_time: row.event_time ?? row.block_time,
    event_type: row.event_type ?? row.trade_type,
    trader: row.trader ?? row.wallet_address,
    address_type: row.address_type,
    is_contract: row.is_contract,
    token_amount: row.token_amount,
    amount_usd: row.amount_usd,
    price: row.price_usd ?? row.price,
    price_usd: row.price_usd ?? row.price,
    balance_after: row.balance_after,
    quote_balance_after: row.quote_balance_after,
    buy_count_after: row.buy_count_after,
    sell_count_after: row.sell_count_after,
    tx_hash: row.tx_hash,
    block_number: row.block_number,
  };
}

function mapWsTrade(data: Record<string, unknown>): Record<string, unknown> {
  const side = String(data.side ?? '').toLowerCase();
  const eventType = side === 'buy' ? 'buy' : side === 'sell' ? 'sell' : side;
  return {
    id: `${data.txHash}-0`,
    event_time: data.blockTime,
    event_type: eventType,
    trader: data.walletAddress,
    address_type: data.addressType,
    is_contract: data.isContract ? 1 : 0,
    token_amount: data.tokenAmount,
    amount_usd: data.amountUsd,
    price: data.priceUsd ?? data.price,
    price_usd: data.priceUsd ?? data.price,
    balance_after: data.balanceAfter,
    quote_balance_after: data.quoteBalanceAfter ?? data.quote_balance_after,
    buy_count_after: data.buyCountAfter,
    sell_count_after: data.sellCountAfter,
    trade_size_label: data.tradeSizeLabel,
    tx_hash: data.txHash,
    block_number: data.blockNumber,
  };
}

function swapsQuery(page: number): string {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', String(PAGE_SIZE));
  if (filterType.value) params.set('type', filterType.value);
  return `?${params.toString()}`;
}

function mergeRows(existing: Record<string, unknown>[], incoming: Record<string, unknown>[]): Record<string, unknown>[] {
  const seen = new Set(existing.map(rowKey));
  const out = [...existing];
  for (const row of incoming) {
    const key = rowKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

async function fetchPage(page: number, append: boolean): Promise<void> {
  if (append) loadingMore.value = true;
  else loading.value = true;
  try {
    const r = await api<{
      items: Record<string, unknown>[];
      total: number;
      page: number;
      pageSize: number;
      quoteSymbol?: string;
      quoteDecimals?: number;
    }>(`/api/v1/tokens/${addr.value}/swaps${swapsQuery(page)}`);
    if (r.quoteSymbol) quoteSymbol.value = r.quoteSymbol;
    if (r.quoteDecimals != null) quoteDecimals.value = r.quoteDecimals;
    total.value = r.total;
    currentPage.value = r.page;
    maxLoadedPage.value = Math.max(maxLoadedPage.value, r.page);
    const mapped = enrichSwapRowsBalanceAfter(r.items.map(mapApiRow));
    swaps.value = append ? mergeRows(swaps.value, mapped) : mapped;
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

function resetList(): void {
  swaps.value = [];
  total.value = 0;
  currentPage.value = 1;
  maxLoadedPage.value = 1;
}

async function loadFirstPage(): Promise<void> {
  resetList();
  await fetchPage(1, false);
}

async function goPage(page: number): Promise<void> {
  if (page < 1 || page > totalPages.value || loading.value || loadingMore.value) return;
  currentPage.value = page;
  await fetchPage(page, false);
}

async function loadMore(): Promise<void> {
  if (!hasMore.value || loading.value || loadingMore.value) return;
  const next = maxLoadedPage.value + 1;
  await fetchPage(next, true);
}

function upsertTrade(row: Record<string, unknown>): void {
  const key = rowKey(row);
  const idx = swaps.value.findIndex((s) => rowKey(s) === key);
  if (idx >= 0) {
    swaps.value[idx] = { ...swaps.value[idx], ...row };
    return;
  }
  if (filterType.value && String(row.event_type) !== filterType.value) return;
  if (currentPage.value !== 1) return;
  swaps.value = [row, ...swaps.value].slice(0, PAGE_SIZE);
  total.value += 1;
}

watch([addr, refreshAt], loadFirstPage, { immediate: true });
watch(filterType, loadFirstPage);

useRealtime((msg) => {
  if (msg.type !== 'new_trade') return;
  if (String(msg.tokenAddress ?? '').toLowerCase() !== addr.value) return;
  const data = (msg.data ?? msg) as Record<string, unknown>;
  upsertTrade(mapWsTrade(data));
});

onActivated(() => {
  if (currentPage.value === 1) void fetchPage(1, false);
});
</script>

<template>
  <div class="space-y-4">
    <div class="page-head flex flex-wrap items-center justify-between gap-2">
      <div>
        <h1>买卖记录</h1>
        <p>
          逐笔成交 · 共 {{ total }} 条
          <span v-if="total > 0" class="text-secondary">
            · 已加载 {{ swaps.length }} 条
          </span>
        </p>
      </div>
      <select v-model="filterType" class="select" :disabled="loading">
        <option value="">全部</option>
        <option value="buy">买入</option>
        <option value="sell">卖出</option>
      </select>
    </div>

    <div class="glass card-pad">
      <div v-if="loading && !swaps.length" class="table-empty py-8">{{ UI.loading }}</div>
      <DataTable
        v-else
        :paginate="false"
        :columns="[
          { key: 'event_time', label: '时间', sortable: true },
          { key: 'event_type', label: '类型' },
          { key: 'trader', label: '地址' },
          { key: 'trade_amount', label: '成交额', sortable: true, align: 'right' },
          { key: 'price', label: '成交单价', align: 'right' },
          { key: 'balance_after', label: '交易后持仓', align: 'right' },
          { key: 'quote_balance_after', label: quoteBalanceLabel, align: 'right' },
          { key: 'trade_counts', label: '累计买卖', align: 'right' },
          { key: 'tx_hash', label: 'Tx' },
        ]"
        :rows="swaps"
        :row-key="rowKey"
      >
        <template #cell-event_time="{ row }">{{ fmtTimeShort(Number(row.event_time)) }}</template>
        <template #cell-event_type="{ row }">
          <span class="inline-flex flex-wrap items-center gap-1">
            <span class="badge" :class="row.event_type === 'buy' ? 'badge-buy' : 'badge-sell'">
              {{ row.event_type === 'buy' ? '买入' : '卖出' }}
            </span>
            <span
              class="badge"
              :class="tradeSizeBadgeClass(Number(row.amount_usd ?? 0))"
            >
              {{ String(row.trade_size_label ?? tradeSizeLabel(Number(row.amount_usd ?? 0))) }}
            </span>
          </span>
        </template>
        <template #cell-trader="{ row }">
          <span v-if="row.trader" class="inline-flex flex-wrap items-center gap-1.5">
            <CopyAddr :address="String(row.trader)" :remark="labelFor(String(row.trader))" />
            <AddressTypeBadge
              :address-type="String(row.address_type ?? '')"
              :is-contract="Boolean(row.is_contract)"
            />
          </span>
        </template>
        <template #cell-trade_amount="{ row }">
          <div class="amount-stack">
            <span class="amount-stack__primary">
              {{ fmtTokenAmount(String(row.token_amount), decimals) }}
            </span>
            <span class="amount-stack__accent">{{ fmtUsd(Number(row.amount_usd ?? 0)) }}</span>
          </div>
        </template>
        <template #cell-price="{ row }">
          {{ fmtPrice(Number(row.price_usd ?? row.price ?? 0)) }}
        </template>
        <template #cell-balance_after="{ row }">
          {{ fmtTokenAmount(String(row.balance_after ?? '0'), decimals) }}
        </template>
        <template #cell-quote_balance_after="{ row }">
          <span v-if="row.quote_balance_after != null && String(row.quote_balance_after) !== ''">
            {{ fmtTokenAmount(String(row.quote_balance_after), quoteDecimals, 4) }}
          </span>
          <span v-else class="text-muted">—</span>
        </template>
        <template #cell-trade_counts="{ row }">
          <span class="text-secondary text-xs">
            买 {{ row.buy_count_after ?? 0 }} / 卖 {{ row.sell_count_after ?? 0 }}
          </span>
        </template>
        <template #cell-tx_hash="{ row }">
          <a class="link text-xs" :href="bscTx(String(row.tx_hash))" target="_blank" rel="noopener">
            {{ String(row.tx_hash).slice(0, 10) }}…
          </a>
        </template>
        <template #mobile-card="{ row }">
          <div class="mobile-card-row">
            <span>{{ fmtTimeShort(Number(row.event_time)) }}</span>
            <span class="inline-flex flex-wrap items-center gap-1">
              <span class="badge" :class="row.event_type === 'buy' ? 'badge-buy' : 'badge-sell'">
                {{ row.event_type === 'buy' ? '买入' : '卖出' }}
              </span>
              <span
                class="badge"
                :class="tradeSizeBadgeClass(Number(row.amount_usd ?? 0))"
              >
                {{ String(row.trade_size_label ?? tradeSizeLabel(Number(row.amount_usd ?? 0))) }}
              </span>
            </span>
          </div>
          <div class="mobile-card-row">
            <span class="inline-flex flex-wrap items-center gap-1.5">
              <CopyAddr v-if="row.trader" :address="String(row.trader)" :remark="labelFor(String(row.trader))" />
              <AddressTypeBadge
                :address-type="String(row.address_type ?? '')"
                :is-contract="Boolean(row.is_contract)"
              />
            </span>
            <div class="amount-stack">
              <span class="amount-stack__primary">
                {{ fmtTokenAmount(String(row.token_amount), decimals) }}
              </span>
              <span class="amount-stack__accent">{{ fmtUsd(Number(row.amount_usd ?? 0)) }}</span>
            </div>
          </div>
          <div class="mobile-card-row text-secondary text-xs">
            交易后持仓 {{ fmtTokenAmount(String(row.balance_after ?? '0'), decimals) }}
          </div>
          <div class="mobile-card-row text-secondary text-xs">
            {{ quoteBalanceLabel }}
            {{
              row.quote_balance_after != null && String(row.quote_balance_after) !== ''
                ? fmtTokenAmount(String(row.quote_balance_after), quoteDecimals, 4)
                : '—'
            }}
          </div>
          <div class="mobile-card-row text-secondary text-xs">
            买 {{ row.buy_count_after ?? 0 }} / 卖 {{ row.sell_count_after ?? 0 }}
          </div>
          <a class="link text-xs" :href="bscTx(String(row.tx_hash))" target="_blank" rel="noopener">{{ UI.viewOnChain }}</a>
        </template>
      </DataTable>

      <div
        v-if="total > 0"
        class="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] pt-4"
      >
        <span class="text-muted text-xs">
          第 {{ currentPage }} / {{ totalPages }} 页 · 每页 {{ PAGE_SIZE }} 条
        </span>
        <div class="flex flex-wrap items-center gap-2">
          <button
            type="button"
            class="btn btn-sm"
            :disabled="currentPage <= 1 || loading || loadingMore"
            @click="goPage(currentPage - 1)"
          >
            上一页
          </button>
          <button
            type="button"
            class="btn btn-sm"
            :disabled="currentPage >= totalPages || loading || loadingMore"
            @click="goPage(currentPage + 1)"
          >
            下一页
          </button>
          <button
            v-if="hasMore"
            type="button"
            class="btn btn-sm btn-default"
            :disabled="loading || loadingMore"
            @click="loadMore"
          >
            {{ loadingMore ? '加载中…' : '加载更多' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
