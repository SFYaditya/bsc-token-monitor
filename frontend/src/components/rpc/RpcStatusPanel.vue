<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api } from '../../api/client';
import { useRealtime } from '../../composables/useRealtime';
import { fmtTimeShort } from '../../utils/format';
import { zhRpcStatus } from '../../utils/locale';

type RpcNode = {
  index: number;
  name: string;
  urlMasked: string;
  status: string;
  latencyMs: number | null;
  latestBlock: number | null;
  failCount: number;
  consecutiveFailures: number;
  lastError: string | null;
  checkedAt: number | null;
  isActive: boolean;
};

type RpcStatusPayload = {
  currentIndex: number;
  current: RpcNode;
  failoverEnabled: boolean;
  healthCheckIntervalMs: number;
  maxLatencyMs: number;
  timeoutMs: number;
  lastCheckAt: number;
  lastSyncedBlock: number | null;
  lagBlocks: number | null;
  syncByToken: {
    token_address: string;
    symbol?: string;
    last_synced_block: number;
    lag_blocks: number;
    slow_lag_blocks?: number;
    chain_head?: number | null;
  }[];
  nodes: RpcNode[];
};

const status = ref<RpcStatusPayload | null>(null);
const loading = ref(false);
const msg = ref('');
const switchMsg = ref('');

const current = computed(() => status.value?.current);

function statusBadgeClass(s: string): string {
  const u = s.toUpperCase();
  if (u === 'HEALTHY') return 'badge-ok';
  if (u === 'HIGH_LATENCY') return 'badge-warn';
  if (u === 'RATE_LIMITED') return 'badge-warn';
  if (u === 'UNAVAILABLE') return 'badge-danger';
  return 'badge-neutral';
}

async function loadStatus() {
  loading.value = true;
  msg.value = '';
  try {
    status.value = await api<RpcStatusPayload>('/api/v1/rpc/status');
  } catch (e) {
    msg.value = e instanceof Error ? e.message : '加载 RPC 状态失败';
  } finally {
    loading.value = false;
  }
}

async function runHealthCheck() {
  loading.value = true;
  switchMsg.value = '';
  try {
    status.value = await api<RpcStatusPayload>('/api/v1/rpc/health-check', { method: 'POST' });
    switchMsg.value = '健康检查已完成';
  } catch (e) {
    switchMsg.value = e instanceof Error ? e.message : '健康检查失败';
  } finally {
    loading.value = false;
  }
}

async function switchRpc(index: number, allowHighLatency = false) {
  loading.value = true;
  switchMsg.value = '';
  try {
    const res = await api<{ warning?: string; status: RpcStatusPayload }>('/api/v1/rpc/switch', {
      method: 'POST',
      body: JSON.stringify({ index, allowHighLatency }),
    });
    status.value = res.status;
    switchMsg.value = res.warning ?? `已切换至 ${res.status.current.name}`;
  } catch (e) {
    switchMsg.value = e instanceof Error ? e.message : '切换失败';
  } finally {
    loading.value = false;
  }
}

function canSwitch(node: RpcNode): boolean {
  const s = node.status.toUpperCase();
  return s !== 'UNAVAILABLE' && s !== 'UNKNOWN' && s !== 'RATE_LIMITED' && !node.isActive;
}

function onSwitchClick(node: RpcNode) {
  if (node.status.toUpperCase() === 'HIGH_LATENCY') {
    if (!confirm(`${node.name} 延迟较高，确定切换？`)) return;
    void switchRpc(node.index, true);
    return;
  }
  void switchRpc(node.index);
}

useRealtime((m) => {
  if (m.type === 'rpc_status_update' && m.data) {
    status.value = m.data as unknown as RpcStatusPayload;
  }
});

onMounted(() => void loadStatus());
</script>

<template>
  <section class="space-y-4">
    <div class="glass card-pad">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="card-title">RPC 节点状态</h3>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="loading" @click="loadStatus">
            刷新
          </button>
          <button type="button" class="btn btn-default btn-sm" :disabled="loading" @click="runHealthCheck">
            立即检测
          </button>
        </div>
      </div>

      <p v-if="msg" class="text-danger mt-2 text-sm">{{ msg }}</p>
      <p v-if="switchMsg" class="text-muted mt-2 text-sm">{{ switchMsg }}</p>

      <div v-if="current" class="stat-row mt-4">
        <div class="glass-inner card-pad text-sm">
          <p class="text-muted mb-1">当前 RPC</p>
          <p class="font-medium">{{ current.name }}</p>
          <p class="text-muted text-xs">{{ current.urlMasked }}</p>
          <p class="mt-2">
            <span class="badge" :class="statusBadgeClass(current.status)">
              {{ zhRpcStatus(current.status) }}
            </span>
          </p>
          <p class="mt-2">延迟：{{ current.latencyMs != null ? `${current.latencyMs} ms` : '—' }}</p>
          <p>链上最新块：{{ current.latestBlock ?? '—' }}</p>
          <p>上次检测：{{ current.checkedAt ? fmtTimeShort(current.checkedAt) : '—' }}</p>
        </div>
        <div class="glass-inner card-pad text-sm">
          <p class="text-muted mb-1">同步进度</p>
          <p>last_synced_block：{{ status?.lastSyncedBlock ?? '—' }}</p>
          <p>lag_blocks：{{ status?.lagBlocks ?? '—' }}</p>
          <p class="mt-2">自动切换：{{ status?.failoverEnabled ? '已开启' : '已关闭' }}</p>
          <p>延迟阈值：{{ status?.maxLatencyMs }} ms</p>
          <template v-if="status?.syncByToken?.length">
            <p class="text-muted mt-3 mb-1">按 Token</p>
            <p v-for="t in status.syncByToken" :key="t.token_address" class="text-xs">
              {{ t.symbol ?? t.token_address.slice(0, 8) }}
              · Pair last={{ t.last_synced_block }} lag={{ t.lag_blocks }}
              <template v-if="(t.slow_lag_blocks ?? 0) > 0">
                · Transfer lag={{ t.slow_lag_blocks }}
              </template>
              <span
                v-if="(t.lag_blocks ?? 0) > 20"
                class="text-[var(--warn)]"
              >（追块中）</span>
            </p>
          </template>
        </div>
      </div>
    </div>

    <div class="glass card-pad overflow-x-auto">
      <table class="data-table w-full text-sm">
        <thead>
          <tr>
            <th>节点</th>
            <th>URL（脱敏）</th>
            <th>状态</th>
            <th>延迟</th>
            <th>最新块</th>
            <th>失败次数</th>
            <th>检测时间</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="node in status?.nodes ?? []" :key="node.index" :class="{ 'row-active': node.isActive }">
            <td>{{ node.name }}</td>
            <td class="font-mono text-xs">{{ node.urlMasked }}</td>
            <td>
              <span class="badge" :class="statusBadgeClass(node.status)">
                {{ zhRpcStatus(node.status) }}
              </span>
              <span v-if="node.isActive" class="badge badge-neutral ml-1">当前</span>
            </td>
            <td>{{ node.latencyMs != null ? `${node.latencyMs} ms` : '—' }}</td>
            <td>{{ node.latestBlock ?? '—' }}</td>
            <td>{{ node.failCount }}</td>
            <td>{{ node.checkedAt ? fmtTimeShort(node.checkedAt) : '—' }}</td>
            <td>
              <button
                v-if="canSwitch(node)"
                type="button"
                class="btn btn-primary btn-sm"
                :disabled="loading"
                @click="onSwitchClick(node)"
              >
                切换
              </button>
              <span v-else-if="node.isActive" class="text-muted text-xs">使用中</span>
              <span v-else class="text-muted text-xs" :title="node.lastError ?? ''">不可切换</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.row-active {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}
.badge-ok {
  background: color-mix(in srgb, #22c55e 18%, transparent);
  color: #15803d;
}
.badge-danger {
  background: color-mix(in srgb, #ef4444 18%, transparent);
  color: #b91c1c;
}
</style>