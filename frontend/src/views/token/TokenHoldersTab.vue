<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../../api/client';
import { holderRankingCacheKey } from '../../composables/useTokenPrefetch';
import { cachedFetch, peekCache } from '../../utils/requestCache';
import { useTokenPage } from '../../composables/useTokenPage';
import { fmtTokenAmount, fmtUsd, fmtAddressLabel, fmtTimeShort } from '../../utils/format';
import { UI } from '../../utils/locale';
import type { GradingPayload } from '../../utils/whaleGrading';
import { patchFromNewTrade } from '../../utils/tradeBalance';
import DataTable from '../../components/ui/DataTable.vue';
import CopyAddr from '../../components/ui/CopyAddr.vue';
import WhaleBadges from '../../components/ui/WhaleBadges.vue';
import AddressTypeBadge from '../../components/ui/AddressTypeBadge.vue';
import { useRealtime } from '../../composables/useRealtime';
import { useWalletRemarks } from '../../composables/useWalletRemarks';
import { debounce } from '../../utils/debounce';

type RankingRow = GradingPayload & {
  rank: number;
  balance_percent: number;
  buy_count: number;
  sell_count: number;
  address_tag?: string | null;
  address_type?: string;
  is_contract?: boolean;
  total_buy_amount?: string;
  total_sell_amount?: string;
  net_buy_amount?: string;
  net_buy_usd?: string;
  last_trade_time?: number | null;
  lpBalanceRaw?: string;
  lpStakedBalanceRaw?: string;
  lpBalanceUsd?: number;
  lpStakedBalanceUsd?: number;
};

type SortBy =
  | 'holding_usd'
  | 'balance'
  | 'buy_count'
  | 'sell_count'
  | 'net_buy'
  | 'last_trade_time';

const FILTERS = [
  { id: 'all', label: '全部持仓' },
  { id: 'whale', label: '巨鲸' },
  { id: 'super_whale', label: '超级巨鲸' },
  { id: 'accumulating', label: '持续加仓' },
  { id: 'reducing', label: '正在减仓' },
  { id: 'staking', label: '质押用户' },
  { id: 'cleared', label: '已清仓' },
  { id: 'new_buy', label: '新买入地址' },
  { id: 'high_impact', label: '高影响' },
] as const;

const SORT_OPTIONS: { id: SortBy; label: string; tableKey: string }[] = [
  { id: 'holding_usd', label: '持仓价值', tableKey: 'holdingUsd' },
  { id: 'balance', label: '持仓数量', tableKey: 'balance' },
  { id: 'buy_count', label: '买入次数', tableKey: 'buy_count' },
  { id: 'sell_count', label: '卖出次数', tableKey: 'sell_count' },
  { id: 'net_buy', label: '净买入', tableKey: 'net_buy' },
  { id: 'last_trade_time', label: '最近交易', tableKey: 'last_trade_time' },
];

const TABLE_KEY_TO_SORT: Record<string, SortBy> = Object.fromEntries(
  SORT_OPTIONS.map((o) => [o.tableKey, o.id]),
) as Record<string, SortBy>;

const { addr, refreshAt } = useTokenPage();
const { labelFor } = useWalletRemarks(addr);
const items = ref<RankingRow[]>([]);
const total = ref(0);
const decimals = ref(18);
const activeFilter = ref<string>('all');
const sortBy = ref<SortBy>('balance');
const sortOrder = ref<'asc' | 'desc'>('desc');
const hasMarket = ref(false);
const showLpColumns = ref(false);

const tableFilters = computed(() => {
  const base: { id: string; label: string }[] = [...FILTERS];
  if (showLpColumns.value) {
    base.splice(6, 0, { id: 'lp_staking', label: 'LP 质押' });
  }
  return base;
});

const tableColumns = computed(() => {
  const cols: {
    key: string;
    label: string;
    sortable?: boolean;
    sortType?: 'bigint';
    align?: 'left' | 'right';
  }[] = [
    { key: 'rank', label: UI.rank },
    { key: 'holding', label: '持仓', sortable: true, sortType: 'bigint', align: 'right' },
  ];
  if (showLpColumns.value) {
    cols.push(
      { key: 'lp_balance', label: 'LP 持仓', sortable: false, align: 'right' },
      { key: 'lp_staked', label: 'LP 质押', sortable: false, align: 'right' },
    );
  }
  cols.push(
    { key: 'buy_count', label: '买入', sortable: true, align: 'right' },
    { key: 'sell_count', label: '卖出', sortable: true, align: 'right' },
    { key: 'net_buy', label: '净买入', sortable: true, sortType: 'bigint', align: 'right' },
    { key: 'last_trade_time', label: '最近交易', sortable: true },
    { key: 'tags', label: '标签' },
  );
  return cols;
});

const tableSortKey = computed(() => {
  if (sortBy.value === 'holding_usd' || sortBy.value === 'balance') return 'holding';
  return SORT_OPTIONS.find((o) => o.id === sortBy.value)?.tableKey ?? 'holding';
});
const tableSortDir = computed(() => (sortOrder.value === 'asc' ? 1 : -1) as 1 | -1);

function rankingQuery(): string {
  return `filter=${activeFilter.value}&pageSize=50&sort=${sortBy.value}&order=${sortOrder.value}`;
}

function applyRanking(r: {
  items: RankingRow[];
  total: number;
  decimals?: number;
  sort?: SortBy;
  order?: 'asc' | 'desc';
  hasMarket?: boolean;
  lpMonitoring?: { enabled?: boolean };
}) {
  items.value = r.items;
  total.value = r.total;
  decimals.value = r.decimals ?? 18;
  hasMarket.value = r.hasMarket ?? false;
  showLpColumns.value = Boolean(r.lpMonitoring?.enabled);
  if (r.sort) sortBy.value = r.sort;
  if (r.order) sortOrder.value = r.order;
}

async function load() {
  const key = holderRankingCacheKey(addr.value, rankingQuery());
  const cached = peekCache<Awaited<ReturnType<typeof fetchRanking>>>(key, 120_000);
  if (cached) applyRanking(cached);

  const r = await cachedFetch(key, fetchRanking, 120_000);
  applyRanking(r);
}

async function fetchRanking() {
  return api<{
    items: RankingRow[];
    total: number;
    decimals: number;
    filter: string;
    sort: SortBy;
    order: 'asc' | 'desc';
    hasMarket: boolean;
    lpMonitoring?: { enabled?: boolean };
  }>(`/api/v1/tokens/${addr.value}/holder-ranking?${rankingQuery()}`);
}

function applySort(next: SortBy) {
  if (sortBy.value !== next) {
    sortBy.value = next;
    sortOrder.value = 'desc';
  }
}

function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc';
}

function onTableSort(payload: { key: string; dir: 1 | -1 }) {
  if (payload.key === 'holding') {
    sortBy.value = hasMarket.value ? 'holding_usd' : 'balance';
  } else {
    const mapped = TABLE_KEY_TO_SORT[payload.key];
    if (!mapped) return;
    sortBy.value = mapped;
  }
  sortOrder.value = payload.dir > 0 ? 'asc' : 'desc';
}

const loadDebounced = debounce(load, 350);
watch([addr, refreshAt, sortBy, sortOrder], load, { immediate: true });
watch(activeFilter, () => loadDebounced());

function patchHolderFromWs(data: Record<string, unknown>): void {
  const wallet = String(data.walletAddress ?? '').toLowerCase();
  if (!wallet) return;
  const idx = items.value.findIndex(
    (r) => String(r.walletAddress ?? '').toLowerCase() === wallet,
  );
  const balanceRaw = String(data.totalBalance ?? data.walletBalance ?? '0');
  const patch: Partial<RankingRow> = {
    walletAddress: wallet,
    balanceRaw,
    holdingUsd: Number(data.balanceUsd ?? 0),
    buy_count: Number(data.buyCount ?? 0),
    sell_count: Number(data.sellCount ?? 0),
    address_type: String(data.addressType ?? 'wallet'),
    is_contract: Boolean(data.isContract),
    total_buy_amount: String(data.totalBuyAmount ?? '0'),
    total_sell_amount: String(data.totalSellAmount ?? '0'),
    net_buy_amount: String(data.netBuyAmount ?? '0'),
    last_trade_time:
      data.lastTradeTime != null ? Number(data.lastTradeTime) : null,
    behaviorTags: (data.behaviorTags as RankingRow['behaviorTags']) ?? [],
    lpBalanceRaw: String(data.lpBalanceRaw ?? data.lp_balance ?? '0'),
    lpStakedBalanceRaw: String(data.lpStakedBalanceRaw ?? data.lp_staked_balance ?? '0'),
    lpBalanceUsd: Number(data.lpBalanceUsd ?? 0),
    lpStakedBalanceUsd: Number(data.lpStakedBalanceUsd ?? 0),
  };
  if (idx >= 0) {
    items.value[idx] = { ...items.value[idx], ...patch };
    resortLocal();
    return;
  }
  if (BigInt(balanceRaw || '0') <= 0n) return;
  const newcomer = asRow({
    rank: items.value.length + 1,
    balance_percent: 0,
    walletAddress: wallet,
    holdingUsd: patch.holdingUsd ?? 0,
    balanceRaw,
    holdingTier: 'small',
    holdingTierLabel: '小户',
    liquidityImpact: 'low',
    liquidityImpactLabel: '低',
    liquidityImpactPct: 0,
    behaviorTags: patch.behaviorTags ?? [],
    behaviorTagLabels: [],
    stakingBalanceRaw: String(data.stakingBalance ?? '0'),
    buy_count: patch.buy_count ?? 0,
    sell_count: patch.sell_count ?? 0,
    address_type: patch.address_type,
    is_contract: patch.is_contract,
    total_buy_amount: patch.total_buy_amount,
    total_sell_amount: patch.total_sell_amount,
    net_buy_amount: patch.net_buy_amount,
    last_trade_time: patch.last_trade_time,
  } as Record<string, unknown>);
  items.value = [newcomer, ...items.value].slice(0, 200);
  resortLocal();
}

function resortLocal(): void {
  const dir = sortOrder.value === 'asc' ? 1 : -1;
  items.value.sort((a, b) => {
    const cmp = (x: number, y: number) => (x > y ? 1 : x < y ? -1 : 0);
    const cmpBig = (x: string, y: string) => {
      const bx = BigInt(x || '0');
      const by = BigInt(y || '0');
      if (bx > by) return 1;
      if (bx < by) return -1;
      return 0;
    };
    let c = 0;
    switch (sortBy.value) {
      case 'holding_usd':
        c = cmp(a.holdingUsd, b.holdingUsd);
        if (c === 0) c = cmpBig(a.balanceRaw ?? '0', b.balanceRaw ?? '0');
        break;
      case 'balance':
        c = cmpBig(a.balanceRaw ?? '0', b.balanceRaw ?? '0');
        break;
      case 'buy_count':
        c = cmp(a.buy_count, b.buy_count);
        break;
      case 'sell_count':
        c = cmp(a.sell_count, b.sell_count);
        break;
      case 'net_buy':
        c = cmpBig(a.net_buy_amount ?? '0', b.net_buy_amount ?? '0');
        break;
      case 'last_trade_time': {
        const ta = a.last_trade_time ?? 0;
        const tb = b.last_trade_time ?? 0;
        if (ta === 0 && tb === 0) c = 0;
        else if (ta === 0) c = 1;
        else if (tb === 0) c = -1;
        else c = ta > tb ? 1 : ta < tb ? -1 : 0;
        break;
      }
    }
    return c * dir;
  });
  items.value.forEach((row, i) => {
    row.rank = i + 1;
  });
}

useRealtime((msg) => {
  if (String(msg.tokenAddress ?? '').toLowerCase() !== addr.value) return;
  if (msg.type === 'holder_update') {
    patchHolderFromWs((msg.data ?? msg) as Record<string, unknown>);
    return;
  }
  if (msg.type === 'new_trade') {
    const patch = patchFromNewTrade((msg.data ?? msg) as Record<string, unknown>);
    if (!patch) return;
    patchHolderFromWs({
      walletAddress: patch.wallet,
      totalBalance: patch.balanceRaw,
      walletBalance: patch.balanceRaw,
      buyCount: patch.buyCount,
      sellCount: patch.sellCount,
      lastTradeTime: patch.lastTradeTime,
    });
    loadDebounced();
  }
});

const filterLabel = computed(
  () => tableFilters.value.find((f) => f.id === activeFilter.value)?.label ?? '全部持仓',
);

const sortLabel = computed(() => {
  const opt = SORT_OPTIONS.find((o) => o.id === sortBy.value);
  const arrow = sortOrder.value === 'desc' ? '↓' : '↑';
  return `${opt?.label ?? '排序'} ${arrow}`;
});

function asRow(row: Record<string, unknown>): RankingRow {
  return row as unknown as RankingRow;
}

</script>

<template>
  <div class="space-y-4">
    <div class="page-head flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1>地址持仓榜</h1>
        <p>
          Holder Ranking · {{ filterLabel }} · 共 {{ total }} 地址
          <span v-if="hasMarket" class="text-[var(--accent)]"> · 按市价计算持仓价值</span>
          <span v-else class="text-secondary"> · 无市价，按持仓数量排序</span>
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-muted text-xs">排序</label>
        <select
          class="select"
          :value="sortBy"
          @change="applySort(($event.target as HTMLSelectElement).value as SortBy)"
        >
          <option
            v-for="opt in SORT_OPTIONS"
            :key="opt.id"
            :value="opt.id"
            :disabled="opt.id === 'holding_usd' && !hasMarket"
          >
            {{ opt.label }}{{ opt.id === 'holding_usd' && hasMarket ? ' (USD)' : '' }}
          </option>
        </select>
        <button type="button" class="btn btn-sm" :title="sortLabel" @click="toggleSortOrder">
          {{ sortOrder === 'desc' ? '降序' : '升序' }}
        </button>
      </div>
    </div>

    <div class="flex flex-wrap gap-2 overflow-x-auto pb-1">
      <button
        v-for="f in tableFilters"
        :key="f.id"
        type="button"
        class="tab shrink-0"
        :class="{ 'tab-active': activeFilter === f.id }"
        @click="activeFilter = f.id"
      >
        {{ f.label }}
      </button>
    </div>

    <div class="glass card-pad">
      <DataTable
        server-sort
        :columns="tableColumns"
        :rows="items"
        row-key="walletAddress"
        :page-size="25"
        :default-sort-key="tableSortKey"
        :default-sort-dir="tableSortDir"
        @sort="onTableSort"
      >
        <template #cell-rank="{ row }">
          <span class="inline-flex flex-wrap items-center gap-1.5">
            <RouterLink class="link" :to="`/tokens/${addr}/address/${asRow(row).walletAddress}`">
              #{{ asRow(row).rank }}
            </RouterLink>
            <CopyAddr :address="String(asRow(row).walletAddress)" :remark="labelFor(String(asRow(row).walletAddress))" />
            <AddressTypeBadge
              :address-type="asRow(row).address_type"
              :is-contract="asRow(row).is_contract"
            />
          </span>
        </template>
        <template #cell-lp_balance="{ row }">
          <div class="amount-stack">
            <span class="amount-stack__primary">
              {{ fmtTokenAmount(String(asRow(row).lpBalanceRaw ?? '0'), 18) }}
            </span>
            <span
              v-if="(asRow(row).lpBalanceUsd ?? 0) > 0"
              class="amount-stack__accent"
            >
              {{ fmtUsd(asRow(row).lpBalanceUsd!) }}
            </span>
          </div>
        </template>
        <template #cell-lp_staked="{ row }">
          <div class="amount-stack">
            <span class="amount-stack__primary">
              {{ fmtTokenAmount(String(asRow(row).lpStakedBalanceRaw ?? '0'), 18) }}
            </span>
            <span
              v-if="(asRow(row).lpStakedBalanceUsd ?? 0) > 0"
              class="amount-stack__accent"
            >
              {{ fmtUsd(asRow(row).lpStakedBalanceUsd!) }}
            </span>
          </div>
        </template>
        <template #cell-buy_count="{ row }">{{ asRow(row).buy_count }}</template>
        <template #cell-sell_count="{ row }">{{ asRow(row).sell_count }}</template>
        <template #cell-net_buy="{ row }">
          {{ fmtTokenAmount(String(asRow(row).net_buy_amount ?? '0'), decimals) }}
        </template>
        <template #cell-last_trade_time="{ row }">
          <span v-if="asRow(row).last_trade_time">
            {{ fmtTimeShort(Number(asRow(row).last_trade_time)) }}
          </span>
          <span v-else class="text-muted">—</span>
        </template>
        <template #cell-holding="{ row }">
          <div class="amount-stack">
            <span class="amount-stack__primary">
              {{ fmtTokenAmount(String(asRow(row).balanceRaw), decimals) }}
            </span>
            <span v-if="asRow(row).holdingUsd > 0" class="amount-stack__accent">
              {{ fmtUsd(asRow(row).holdingUsd) }}
            </span>
            <span v-else class="amount-stack__secondary">无市价</span>
          </div>
        </template>
        <template #cell-tags="{ row }">
          <WhaleBadges :grading="asRow(row)" compact />
        </template>
        <template #mobile-card="{ row }">
          <div class="flex items-start justify-between gap-2">
            <RouterLink class="link text-sm" :to="`/tokens/${addr}/address/${asRow(row).walletAddress}`">
              #{{ asRow(row).rank }}
            </RouterLink>
            <div class="amount-stack">
              <span class="amount-stack__primary">
                {{ fmtTokenAmount(String(asRow(row).balanceRaw), decimals) }}
              </span>
              <span v-if="asRow(row).holdingUsd > 0" class="amount-stack__accent">
                {{ fmtUsd(asRow(row).holdingUsd) }}
              </span>
              <span v-else class="amount-stack__secondary">无市价</span>
            </div>
          </div>
          <span class="mt-1 inline-flex flex-wrap items-center gap-1.5">
            <CopyAddr :address="String(asRow(row).walletAddress)" :remark="labelFor(String(asRow(row).walletAddress))" />
            <AddressTypeBadge
              :address-type="asRow(row).address_type"
              :is-contract="asRow(row).is_contract"
            />
          </span>
          <WhaleBadges :grading="asRow(row)" compact />
          <span v-if="asRow(row).address_tag" class="badge badge-neutral mt-2">{{ fmtAddressLabel(String(asRow(row).address_tag)) }}</span>
        </template>
      </DataTable>
    </div>
  </div>
</template>
