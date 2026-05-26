<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { useAppStore, tokenOverviewPath } from '../../composables/useAppStore';
import { prefetchTokenBundle } from '../../composables/useTokenPrefetch';
import { bscTx } from '../../utils/format';
import { UI, zhRpcStatus } from '../../utils/locale';

const route = useRoute();
const router = useRouter();
const { tokens, timeRange, loadTokens, loadRpc, refresh, refreshAt, rpc, currentToken, setToken } =
  useAppStore();

const search = ref('');
let pollTimer: ReturnType<typeof setInterval>;

const rpcMs = computed(() => Number(rpc.value.latencyMs ?? rpc.value.latency ?? -1));
const rpcStatus = computed(() => String(rpc.value.status ?? '').toUpperCase());
const rpcTitle = computed(() => String(rpc.value.urlMasked ?? rpc.value.current_rpc ?? ''));

const showChartRange = computed(
  () => !!route.path.match(/^\/tokens\/[^/]+\/overview$/),
);

const brandLink = computed(() =>
  currentToken.value ? tokenOverviewPath(currentToken.value) : '/',
);

function onSearch() {
  const q = search.value.trim();
  if (!q) return;
  if (q.startsWith('0x') && q.length === 66) {
    window.open(bscTx(q), '_blank');
    return;
  }
  if (q.startsWith('0x') && q.length === 42) {
    const token = currentToken.value || String(tokens.value[0]?.contract_address ?? '');
    if (token) void router.push(`/tokens/${token}/address/${q.toLowerCase()}`);
  }
}

function switchToken(addr: string) {
  const v = addr.toLowerCase();
  if (v === currentToken.value) return;
  setToken(v);
  void prefetchTokenBundle(v, timeRange.value);
  if (route.path.startsWith('/tokens/') && route.params.address) {
    const rest = route.path.replace(/^\/tokens\/[^/]+/, '') || '/overview';
    void router.replace(`/tokens/${v}${rest}`);
  } else {
    void router.replace(tokenOverviewPath(v));
  }
}

function onTokenHover(addr: string) {
  void prefetchTokenBundle(String(addr).toLowerCase(), timeRange.value);
}

function isTokenActive(addr: string): boolean {
  return currentToken.value === String(addr).toLowerCase();
}

onMounted(() => {
  void loadTokens();
  void loadRpc();
  pollTimer = setInterval(() => {
    void loadRpc();
    void loadTokens();
  }, 15000);
});
onUnmounted(() => clearInterval(pollTimer));
</script>

<template>
  <header class="topbar shell-top">
    <RouterLink :to="brandLink" class="brand">
      <span class="brand-dot" />
      {{ UI.brand }}
    </RouterLink>

    <select v-if="showChartRange" v-model="timeRange" class="select" title="图表时间范围">
      <option value="1h">1 小时</option>
      <option value="24h">24 小时</option>
      <option value="7d">7 天</option>
    </select>

    <div class="topbar-search">
      <input
        v-model="search"
        class="input"
        :placeholder="`搜索${UI.address} / ${UI.txHash}…`"
        @keyup.enter="onSearch"
      />
    </div>

    <div class="topbar-actions">
      <div v-if="tokens.length" class="token-switch" role="group" aria-label="切换代币">
        <button
          v-for="t in tokens"
          :key="String(t.contract_address)"
          type="button"
          class="token-switch-btn"
          :class="{ 'token-switch-btn-active': isTokenActive(String(t.contract_address)) }"
          :title="String(t.contract_address)"
          @mouseenter="onTokenHover(String(t.contract_address))"
          @focus="onTokenHover(String(t.contract_address))"
          @click="switchToken(String(t.contract_address))"
        >
          {{ t.token_symbol }}
        </button>
      </div>
      <span
        class="badge"
        :class="
          rpcStatus === 'HEALTHY'
            ? 'badge-neutral'
            : rpcStatus === 'HIGH_LATENCY' || rpcStatus === 'RATE_LIMITED'
              ? 'badge-warn'
              : rpcStatus === 'UNAVAILABLE'
                ? 'badge-danger'
                : 'badge-neutral'
        "
        :title="rpcTitle"
      >
        {{ UI.rpc }}
        {{ rpcStatus ? zhRpcStatus(rpcStatus) : '' }}
        {{ rpcMs >= 0 ? `${rpcMs}${UI.ms}` : '' }}
      </span>
      <button type="button" class="btn btn-ghost btn-icon" :title="UI.refresh" @click="refresh">↻</button>
      <span class="text-muted text-xs">{{ new Date(refreshAt).toLocaleTimeString('zh-CN') }}</span>
    </div>
  </header>
</template>
