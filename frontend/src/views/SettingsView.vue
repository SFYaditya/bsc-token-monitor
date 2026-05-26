<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api, apiRaw } from '../api/client';
import { fmtTimeShort, fmtUsd } from '../utils/format';
import { UI, zhAlertLevel, zhApiError } from '../utils/locale';
import { formatAlertTypeDisplay } from '../utils/alertDisplay';
import DataTable from '../components/ui/DataTable.vue';
import CopyAddr from '../components/ui/CopyAddr.vue';
import RpcStatusPanel from '../components/rpc/RpcStatusPanel.vue';

const route = useRoute();
const router = useRouter();
const tab = computed(() => (route.query.tab === 'system' ? 'system' : 'alerts'));

function setTab(t: 'alerts' | 'system') {
  void router.replace({ path: '/settings', query: t === 'system' ? { tab: 'system' } : {} });
}

const alerts = ref<Record<string, unknown>[]>([]);
const status = ref<Record<string, unknown> | null>(null);
const scanFrom = ref('');
const scanTo = ref('');
const msg = ref('');

const rpc = computed(() => (status.value?.rpc ?? {}) as Record<string, unknown>);
const telegram = computed(() => (status.value?.telegram ?? {}) as Record<string, unknown>);

async function loadAlerts() {
  alerts.value = (await api<{ items: Record<string, unknown>[] }>('/api/v1/alerts?pageSize=100')).items;
}

async function loadSystem() {
  status.value = await api('/api/v1/system/status');
}

async function testNotify() {
  msg.value = '';
  const res = await apiRaw('/api/v1/notify/test', { method: 'POST' });
  const j = await res.json();
  msg.value = zhApiError(String(j.message ?? j.error ?? ''));
}

async function runScan() {
  msg.value = '';
  try {
    const data = await api('/api/v1/scan', {
      method: 'POST',
      body: JSON.stringify({ fromBlock: Number(scanFrom.value), toBlock: Number(scanTo.value) }),
    });
    msg.value = `${UI.scanDone}：${JSON.stringify(data)}`;
    await loadSystem();
  } catch (e) {
    msg.value = zhApiError(e instanceof Error ? e.message : '扫描失败');
  }
}

watch(tab, () => void (tab.value === 'alerts' ? loadAlerts() : loadSystem()));
onMounted(() => void (tab.value === 'alerts' ? loadAlerts() : loadSystem()));
</script>

<template>
  <div class="space-y-4">
    <div class="page-head">
      <h1>设置</h1>
      <p>告警历史 · 系统与节点配置</p>
    </div>
    <div class="tabs">
      <button type="button" class="tab" :class="{ 'tab-active': tab === 'alerts' }" @click="setTab('alerts')">告警中心</button>
      <button type="button" class="tab" :class="{ 'tab-active': tab === 'system' }" @click="setTab('system')">系统配置</button>
    </div>

    <div v-if="tab === 'alerts'" class="glass card-pad">
      <DataTable
        :columns="[
          { key: 'created_at', label: UI.time, sortable: true },
          { key: 'alert_type', label: UI.type },
          { key: 'amount_usd', label: UI.usd, sortable: true, align: 'right' },
        ]"
        :rows="alerts"
        row-key="id"
        :page-size="25"
      >
        <template #cell-created_at="{ row }">{{ fmtTimeShort(Number(row.created_at)) }}</template>
        <template #cell-alert_type="{ row }">
          <span v-if="formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).isTrade" class="inline-flex flex-wrap gap-1">
            <span class="badge" :class="formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).sideClass">
              {{ formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).sideLabel }}
            </span>
            <span class="badge" :class="formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).sizeClass">
              {{ formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).sizeLabel }}
            </span>
          </span>
          <span v-else class="badge badge-warn">
            {{ formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).fallbackLabel }}
          </span>
        </template>
        <template #cell-amount_usd="{ row }">{{ fmtUsd(Number(row.amount_usd ?? 0)) }}</template>
        <template #mobile-card="{ row }">
          <span v-if="formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).isTrade" class="inline-flex gap-1">
            <span class="badge" :class="formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).sideClass">
              {{ formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).sideLabel }}
            </span>
            <span class="badge" :class="formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).sizeClass">
              {{ formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).sizeLabel }}
            </span>
          </span>
          <span v-else class="badge badge-warn">
            {{ formatAlertTypeDisplay(String(row.alert_type), row.amount_usd).fallbackLabel }}
          </span>
          <span v-if="row.level" class="badge badge-neutral ml-1">{{ zhAlertLevel(String(row.level)) }}</span>
          <CopyAddr
            v-if="row.wallet_address"
            :address="String(row.wallet_address)"
            :token="String(row.token_address ?? '')"
            class="mt-2"
          />
        </template>
      </DataTable>
    </div>

    <div v-else class="space-y-4">
      <RpcStatusPanel />

      <div v-if="status" class="stat-row">
        <div class="glass card-pad text-sm text-secondary">
          <p>{{ UI.rpc }}：{{ rpc.current_rpc }}</p>
          <p>延迟：{{ rpc.latency }} {{ UI.ms }}</p>
          <p>最新区块：{{ rpc.latest_block }}</p>
          <p>已扫描区块：{{ status.last_scanned_block ?? '—' }}</p>
        </div>
        <div class="glass card-pad text-sm text-secondary">
          <p>{{ UI.telegram }}：{{ telegram.enabled ? '已开启' : '已关闭' }}</p>
          <button class="btn btn-primary mt-3" @click="testNotify">测试通知</button>
        </div>
      </div>
      <div class="glass card-pad">
        <h3 class="card-title">手动扫块</h3>
        <div class="flex flex-wrap gap-2">
          <input v-model="scanFrom" class="input w-36" :placeholder="UI.blockFrom" />
          <input v-model="scanTo" class="input w-36" :placeholder="UI.blockTo" />
          <button class="btn btn-default" @click="runScan">扫描</button>
        </div>
        <p v-if="msg" class="text-muted mt-2 text-sm">{{ msg }}</p>
      </div>
    </div>
  </div>
</template>
