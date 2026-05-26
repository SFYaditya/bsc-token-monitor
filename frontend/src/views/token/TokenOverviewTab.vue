<script setup lang="ts">
import { computed, onActivated, ref, watch } from 'vue';
import { api } from '../../api/client';
import { useTokenPage } from '../../composables/useTokenPage';
import { useAppStore } from '../../composables/useAppStore';
import { chartCacheKey, overviewCacheKey } from '../../composables/useTokenPrefetch';
import { cachedFetch, peekCache } from '../../utils/requestCache';
import { fmtUsd, fmtPct, fmtPrice, trendBadge, riskBadge, fmtTrend, fmtRiskLevel } from '../../utils/format';
import { UI } from '../../utils/locale';
import LineChart from '../../components/ui/LineChart.vue';
import VolumeChart from '../../components/ui/VolumeChart.vue';
import { useRealtime } from '../../composables/useRealtime';

const { addr, timeRange, refreshAt } = useTokenPage();
const { tokens } = useAppStore();

const tokenSymbol = computed(() => {
  const row = tokens.value.find(
    (t) => String(t.contract_address).toLowerCase() === addr.value,
  );
  return String(row?.token_symbol ?? overview.value?.symbol ?? '').toUpperCase();
});
const overview = ref<Record<string, unknown> | null>(null);
const opportunity = ref<Record<string, unknown> | null>(null);
const risk = ref<Record<string, unknown> | null>(null);
const chart = ref<{ price: { t: number; price: number }[]; volume: { t: number; buyUsd: number; sellUsd: number }[] } | null>(null);
const refreshing = ref(false);
let loadSeq = 0;

const pricePoints = computed(() => (chart.value?.price ?? []).map((p) => ({ t: p.t, v: p.price })));

const pressure = computed(() => {
  const buy = Number(overview.value?.buyVolume24hUsd ?? 0);
  const sell = Number(overview.value?.sellVolume24hUsd ?? 0);
  const t = buy + sell || 1;
  return { buy, sell, buyPct: (buy / t) * 100, sellPct: (sell / t) * 100 };
});

function applyOverviewBundle(ov: {
  overview: Record<string, unknown>;
  opportunity?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  chart?: typeof chart.value;
}) {
  overview.value = ov.overview;
  if (ov.opportunity) opportunity.value = ov.opportunity;
  if (ov.risk) risk.value = ov.risk;
  if (ov.chart) chart.value = ov.chart;
}

function hydrateFromCache() {
  const a = addr.value;
  const ov = peekCache<{ overview: Record<string, unknown> }>(overviewCacheKey(a), 120_000);
  if (ov?.overview) overview.value = ov.overview;
  const opp = peekCache<{ opportunity: Record<string, unknown> }>(`opportunity:${a}`, 120_000);
  if (opp?.opportunity) opportunity.value = opp.opportunity;
  const rk = peekCache<{ risk: Record<string, unknown> }>(`risk:${a}`, 120_000);
  if (rk?.risk) risk.value = rk.risk;
  const ch = peekCache<typeof chart.value>(chartCacheKey(a, timeRange.value), 120_000);
  if (ch) chart.value = ch;
}

async function load(opts?: { refreshPrice?: boolean; silent?: boolean }) {
  const seq = ++loadSeq;
  const a = addr.value;
  const range = timeRange.value;
  hydrateFromCache();
  if (!opts?.silent && opts?.refreshPrice) refreshing.value = true;
  const priceQ = opts?.refreshPrice ? '?refresh=1' : '';

  try {
    const [ov, opp, rk, ch] = await Promise.all([
      cachedFetch(overviewCacheKey(a), () =>
        api<{ overview: Record<string, unknown> }>(
          `/api/v1/tokens/${a}/overview${priceQ}`,
        ),
      ),
      cachedFetch(`opportunity:${a}`, () =>
        api<{ opportunity: Record<string, unknown> }>(`/api/v1/tokens/${a}/opportunity`),
      ),
      cachedFetch(`risk:${a}`, () =>
        api<{ risk: Record<string, unknown> }>(`/api/v1/tokens/${a}/risk`),
      ),
      cachedFetch(chartCacheKey(a, range), () =>
        api<{ price: { t: number; price: number }[]; volume: { t: number; buyUsd: number; sellUsd: number }[] }>(
          `/api/v1/tokens/${a}/chart?range=${range}`,
        ),
      ),
    ]);
    applyOverviewBundle({
      overview: ov.overview,
      opportunity: opp.opportunity,
      risk: rk.risk,
      chart: ch,
    });
  } catch (e) {
    console.error('[overview]', e);
  } finally {
    if (seq === loadSeq) refreshing.value = false;
  }
}

watch([addr, timeRange], () => load(), { immediate: true });
watch(refreshAt, () => load({ refreshPrice: true }));

onActivated(() => {
  refreshing.value = false;
  if (!overview.value) void load();
});

useRealtime((msg) => {
  if (String(msg.tokenAddress ?? '').toLowerCase() !== addr.value) return;
  if (msg.type === 'price_update' && msg.data && overview.value) {
    overview.value = {
      ...overview.value,
      priceUsd: Number(msg.data.price ?? overview.value.priceUsd),
      priceChange24h: Number(msg.data.priceChange24h ?? overview.value.priceChange24h),
    };
    return;
  }
  if (msg.type === 'new_trade') {
    void load({ silent: true });
  }
});
</script>

<template>
  <div v-if="overview" class="space-y-4">
    <div class="page-head">
      <h1>{{ tokenSymbol || '代币' }} 总览</h1>
      <p>当前代币 · 价格 · 买卖强度 · 机会与风险</p>
    </div>

    <div
      v-if="overview.hasMarket === false"
      class="glass card-pad border border-amber-500/30 text-sm text-amber-200/90"
    >
      未检测到 PancakeSwap 流动性池，暂无链上价格与 Swap 数据；Transfer 回补与持仓统计仍会继续同步。
    </div>

    <div class="stat-row">
      <div class="glass card-pad">
        <div class="metric-label">Pancake</div>
        <div class="metric-value">{{ fmtPrice(Number(overview.priceUsd ?? 0)) }}</div>
        <div :class="Number(overview.priceChange24h) >= 0 ? 'up text-sm' : 'down text-sm'">
          24 小时 {{ fmtPct(Number(overview.priceChange24h ?? 0)) }}
        </div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">24 小时成交额</div>
        <div class="metric-value-sm">{{ fmtUsd(Number(overview.volume24hUsd ?? 0)) }}</div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">净买入</div>
        <div class="metric-value-sm" :class="Number(overview.netBuyVolume24hUsd) >= 0 ? 'up' : 'down'">
          {{ fmtUsd(Number(overview.netBuyVolume24hUsd ?? 0)) }}
        </div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">流动性</div>
        <div class="metric-value-sm">{{ fmtUsd(Number(overview.liquidityUsd ?? 0)) }}</div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">持币地址</div>
        <div class="metric-value-sm">{{ overview.holderCount ?? '—' }}</div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">机会评分</div>
        <span class="badge" :class="trendBadge(String(opportunity?.trend))">
          {{ opportunity?.score ?? '—' }} · {{ fmtTrend(String(opportunity?.trend)) }}
        </span>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">风险等级</div>
        <span class="badge" :class="riskBadge(String(risk?.risk_level))">
          {{ fmtRiskLevel(String(risk?.risk_level)) }}
        </span>
      </div>
    </div>

    <div class="dashboard-mid">
      <div class="glass card-pad">
        <h3 class="card-title">价格走势</h3>
        <LineChart :points="pricePoints" :height="200" />
      </div>
      <div class="glass card-pad">
        <h3 class="card-title">成交量</h3>
        <VolumeChart :bars="chart?.volume ?? []" :height="200" />
      </div>
    </div>

    <div class="glass card-pad">
      <h3 class="card-title">买卖强度</h3>
      <div class="mb-2 flex justify-between text-xs text-secondary">
        <span class="up">买盘 {{ fmtUsd(pressure.buy) }}</span>
        <span class="down">卖盘 {{ fmtUsd(pressure.sell) }}</span>
      </div>
      <div class="pressure-bar">
        <div class="pressure-buy" :style="{ width: `${pressure.buyPct}%` }" />
        <div class="pressure-sell" :style="{ width: pressure.sellPct + '%' }" />
      </div>
    </div>
  </div>
  <div v-else class="loading">{{ UI.loading }}</div>
</template>