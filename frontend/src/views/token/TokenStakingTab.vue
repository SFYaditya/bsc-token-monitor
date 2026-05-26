<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../../api/client';
import { useTokenPage } from '../../composables/useTokenPage';
import { cachedFetch, invalidateCache } from '../../utils/requestCache';
import { fmtTimeShort, fmtEventType, fmtTokenAmount, fmtUsd, bscTx, shortAddr } from '../../utils/format';
import DataTable from '../../components/ui/DataTable.vue';
import CopyAddr from '../../components/ui/CopyAddr.vue';

type LpStakingStat = {
  total_lp_staked?: string;
  lp_staker_count?: number;
  staking_contract?: string;
};

type LpStakerRow = {
  wallet_address: string;
  lp_staked_balance: string;
  lp_staked_balance_usd?: number;
  stake_count?: number;
  last_stake_time?: number | null;
  last_stake_tx_hash?: string | null;
};

const { addr, refreshAt } = useTokenPage();
const stat = ref<Record<string, unknown> | null>(null);
const records = ref<Record<string, unknown>[]>([]);
const lpStakers = ref<LpStakerRow[]>([]);
const lpStakersTotal = ref(0);
const lpStakingStat = ref<LpStakingStat | null>(null);
const lpMonitoringEnabled = ref(false);
const loading = ref(true);
const loadError = ref('');
const rescanning = ref(false);
const rescanMsg = ref('');

function stakingCacheKey(a: string): string {
  return `staking:${a.toLowerCase()}`;
}

const showLpTable = computed(
  () => lpMonitoringEnabled.value && (lpStakers.value.length > 0 || lpStakersTotal.value > 0),
);
const showClassicTable = computed(() => records.value.length > 0);

async function fetchStaking() {
  return api<{
    stat: Record<string, unknown> | null;
    items: Record<string, unknown>[];
    lpMonitoring?: { enabled?: boolean } | null;
    lpStakingStat?: LpStakingStat | null;
    lpStakers?: { items: LpStakerRow[]; total: number } | null;
  }>(`/api/v1/tokens/${addr.value}/staking?pageSize=50`);
}

function applyStaking(r: Awaited<ReturnType<typeof fetchStaking>>) {
  stat.value = r.stat;
  records.value = r.items ?? [];
  lpMonitoringEnabled.value = Boolean(r.lpMonitoring?.enabled);
  lpStakingStat.value = r.lpStakingStat ?? null;
  lpStakers.value = r.lpStakers?.items ?? [];
  lpStakersTotal.value = r.lpStakers?.total ?? 0;
  loadError.value = '';
}

async function load(force = false) {
  const key = stakingCacheKey(addr.value);
  if (force) invalidateCache(key);
  loading.value = true;
  loadError.value = '';
  try {
    const r = await cachedFetch(key, fetchStaking, force ? 0 : 30_000);
    applyStaking(r);
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : '加载质押数据失败';
    lpStakers.value = [];
    lpStakersTotal.value = 0;
  } finally {
    loading.value = false;
  }
}

async function rescanLpStakers() {
  rescanMsg.value = '';
  rescanning.value = true;
  try {
    const r = await api<{
      walletsDiscovered: number;
      recordsInserted: number;
      fromBlock: number;
      toBlock: number;
    }>(`/api/v1/tokens/${addr.value}/staking/rescan`, {
      method: 'POST',
      body: JSON.stringify({ autoDetectFromBlock: true, purgeRecords: true }),
      timeoutMs: 600_000,
    });
    rescanMsg.value = `已重扫：${r.walletsDiscovered} 个质押地址，${r.recordsInserted} 条流水（区块 ${r.fromBlock}–${r.toBlock}）`;
    await load(true);
  } catch (e) {
    rescanMsg.value = e instanceof Error ? e.message : '重扫失败';
  } finally {
    rescanning.value = false;
  }
}

watch([addr, refreshAt], () => load(true));
onMounted(() => load(false));
</script>

<template>
  <div class="space-y-4">
    <div class="page-head flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1>质押</h1>
        <p>质押统计与链上质押流水</p>
      </div>
      <button
        v-if="lpMonitoringEnabled"
        type="button"
        class="btn btn-default"
        :disabled="rescanning || loading"
        @click="rescanLpStakers"
      >
        {{ rescanning ? '重扫中…' : '重新拉取质押地址' }}
      </button>
    </div>
    <p v-if="rescanMsg" class="text-muted text-sm">{{ rescanMsg }}</p>

    <p v-if="loading" class="text-muted text-sm">加载中…</p>
    <p v-else-if="loadError" class="glass card-pad text-[var(--danger)]">{{ loadError }}</p>

    <p
      v-if="lpMonitoringEnabled && lpStakingStat"
      class="text-muted text-sm glass-inner card-pad"
    >
      LP 质押合约
      <CopyAddr :address="String(lpStakingStat.staking_contract ?? '')" :to-detail="false" />
      · 链上质押总量 {{ fmtTokenAmount(String(lpStakingStat.total_lp_staked ?? '0'), 18) }}
      · 质押地址数 {{ lpStakingStat.lp_staker_count ?? 0 }}
    </p>

    <div v-if="lpMonitoringEnabled && lpStakingStat" class="stat-row">
      <div class="glass card-pad">
        <div class="metric-label">LP 质押总量</div>
        <div class="metric-value-sm">
          {{ fmtTokenAmount(String(lpStakingStat.total_lp_staked ?? '0'), 18) }}
        </div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">质押地址数</div>
        <div class="metric-value-sm">{{ lpStakingStat.lp_staker_count ?? 0 }}</div>
      </div>
    </div>

    <div v-else-if="stat" class="stat-row">
      <div class="glass card-pad">
        <div class="metric-label">总质押量</div>
        <div class="metric-value-sm">{{ stat.total_staked ?? '—' }}</div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">质押地址数</div>
        <div class="metric-value-sm">{{ stat.staker_count ?? '—' }}</div>
      </div>
    </div>

    <div v-if="showLpTable" class="glass card-pad">
      <h3 class="card-title">LP 质押地址（{{ lpStakersTotal }}）</h3>
      <DataTable
        :columns="[
          { key: 'wallet_address', label: '地址' },
          { key: 'last_stake_time', label: '时间', sortable: true },
          { key: 'last_stake_tx_hash', label: '哈希' },
          { key: 'lp_staked', label: '质押数量', align: 'right' },
          { key: 'stake_count', label: '质押次数', align: 'right' },
        ]"
        :rows="lpStakers"
        row-key="wallet_address"
        :page-size="20"
      >
        <template #cell-wallet_address="{ row }">
          <RouterLink
            class="link"
            :to="`/addresses/${String(row.wallet_address)}?token=${addr}`"
          >
            <CopyAddr :address="String(row.wallet_address)" />
          </RouterLink>
        </template>
        <template #cell-last_stake_time="{ row }">
          <span v-if="row.last_stake_time">{{ fmtTimeShort(Number(row.last_stake_time)) }}</span>
          <span v-else class="text-muted">—</span>
        </template>
        <template #cell-last_stake_tx_hash="{ row }">
          <a
            v-if="row.last_stake_tx_hash"
            class="link text-xs font-mono"
            :href="bscTx(String(row.last_stake_tx_hash))"
            target="_blank"
            rel="noopener"
          >
            {{ shortAddr(String(row.last_stake_tx_hash), 8, 6) }}
          </a>
          <span v-else class="text-muted">—</span>
        </template>
        <template #cell-lp_staked="{ row }">
          <div class="amount-stack">
            <span class="amount-stack__primary">
              {{ fmtTokenAmount(String(row.lp_staked_balance), 18) }}
            </span>
            <span
              v-if="Number(row.lp_staked_balance_usd ?? 0) > 0"
              class="amount-stack__accent"
            >
              {{ fmtUsd(Number(row.lp_staked_balance_usd ?? 0)) }}
            </span>
          </div>
        </template>
        <template #cell-stake_count="{ row }">
          {{ Number(row.stake_count ?? 0) }}
        </template>
      </DataTable>
    </div>

    <div
      v-else-if="!loading && !loadError && lpMonitoringEnabled && lpStakersTotal === 0 && !showClassicTable"
      class="glass card-pad text-muted"
    >
      暂无 LP 质押地址。若刚完成质押，请点顶部刷新或等待链上同步（约 1 分钟）。
    </div>

    <div v-if="showClassicTable" class="glass card-pad">
      <h3 class="card-title">代币质押记录</h3>
      <DataTable
        :columns="[
          { key: 'event_time', label: '时间', sortable: true },
          { key: 'event_type', label: '类型' },
          { key: 'wallet_address', label: '地址' },
        ]"
        :rows="records"
        row-key="id"
        :page-size="20"
      >
        <template #cell-event_time="{ row }">{{ fmtTimeShort(Number(row.event_time)) }}</template>
        <template #cell-event_type="{ row }">
          <span class="badge badge-stake">{{ fmtEventType(String(row.event_type ?? row.action)) }}</span>
        </template>
        <template #cell-wallet_address="{ row }">
          <CopyAddr :address="String(row.wallet_address ?? row.from_address)" />
        </template>
      </DataTable>
    </div>
  </div>
</template>
