<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../../api/client';
import { useTokenPage } from '../../composables/useTokenPage';
import { fmtUsd, fmtPct } from '../../utils/format';
import { UI } from '../../utils/locale';

const { addr, refreshAt } = useTokenPage();
const liquidity = ref<Record<string, unknown> | null>(null);
const market = ref<Record<string, unknown> | null>(null);

async function load() {
  const r = await api<{ liquidity: Record<string, unknown>; market: Record<string, unknown> }>(
    `/api/v1/tokens/${addr.value}/liquidity`,
  );
  liquidity.value = r.liquidity;
  market.value = r.market;
}

watch([addr, refreshAt], load);
onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <div class="page-head">
      <h1>流动性</h1>
      <p>LP 池深度 · 锁定与变化</p>
    </div>
    <div class="stat-row">
      <div class="glass card-pad">
        <div class="metric-label">LP 价值</div>
        <div class="metric-value-sm">{{ fmtUsd(Number(market?.liquidityUsd ?? liquidity?.liquidity_usd ?? 0)) }}</div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">{{ UI.hour24 }}变化</div>
        <div
          class="metric-value-sm"
          :class="Number(liquidity?.change_24h_pct ?? 0) >= 0 ? 'up' : 'down'"
        >
          {{ fmtPct(Number(liquidity?.change_24h_pct ?? 0)) }}
        </div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">LP 锁定</div>
        <div class="metric-value-sm">{{ liquidity?.lp_burned_pct ?? '—' }}%</div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">{{ UI.day7 }}变化</div>
        <div class="metric-value-sm">{{ fmtPct(Number(liquidity?.change_7d_pct ?? 0)) }}</div>
      </div>
    </div>
    <div class="glass card-pad text-secondary text-sm">
      <p>{{ UI.pairAddress }}：{{ liquidity?.pair_address ?? '—' }}</p>
      <p>{{ UI.lockerAddress }}：{{ liquidity?.locker_address ?? '—' }}</p>
    </div>
  </div>
</template>
