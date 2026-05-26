import { computed, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api/client';
import { invalidateCache } from '../utils/requestCache';
import { setRealtimeChannels } from './useRealtime';
import { prefetchTokenBundles } from './useTokenPrefetch';

const tokens = ref<Record<string, unknown>[]>([]);
const apiError = ref('');
const timeRange = ref<'1h' | '24h' | '7d'>('24h');
const refreshAt = ref(Date.now());
const rpc = ref<Record<string, unknown>>({});
const ACTIVE_TOKEN_KEY = 'active_token';
const activeToken = ref(localStorage.getItem(ACTIVE_TOKEN_KEY) ?? '');

export function tokenOverviewPath(addr: string): string {
  return `/tokens/${addr.toLowerCase()}/overview`;
}

export function defaultTokenPath(): string {
  const saved = activeToken.value || localStorage.getItem(ACTIVE_TOKEN_KEY) || '';
  if (saved) return tokenOverviewPath(saved);
  const first = tokens.value[0]?.contract_address;
  if (first) return tokenOverviewPath(String(first));
  return '/settings';
}

export function useAppStore() {
  const route = useRoute();
  const router = useRouter();

  const routeToken = computed(() => {
    const a = route.params.address;
    return a ? String(a).toLowerCase() : '';
  });

  const currentToken = computed(() => routeToken.value || activeToken.value);

  async function loadTokens(status = '') {
    try {
      const q = status ? `?status=${encodeURIComponent(status)}&pageSize=50` : '?pageSize=50';
      const res = await api<{ items: Record<string, unknown>[] }>(`/api/v1/tokens${q}`);
      tokens.value = res.items;
      apiError.value = '';
      prefetchTokenBundles(
        res.items.map((t) => String(t.contract_address ?? '')),
        timeRange.value,
      );
      if (!activeToken.value && res.items[0]) {
        activeToken.value = String(res.items[0].contract_address).toLowerCase();
        localStorage.setItem(ACTIVE_TOKEN_KEY, activeToken.value);
      }
    } catch (e) {
      apiError.value = e instanceof Error ? e.message : '无法连接后端 API';
    }
  }

  async function importToken(address: string, pairAddress?: string) {
    const body: Record<string, string> = { address: address.trim() };
    const pair = pairAddress?.trim();
    if (pair) body.pair_address = pair;
    const result = await api<{
      contract: { contract_address: string };
      created: boolean;
      pair_discovered: boolean;
      status_label: string;
    }>('/api/v1/tokens/import', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    await loadTokens();
    const addr = String(result.contract.contract_address).toLowerCase();
    setToken(addr);
    return result;
  }

  async function loadRpc() {
    try {
      const data = await api<{ rpc: Record<string, unknown>; rpcDetail?: Record<string, unknown> }>(
        '/api/v1/system/status',
      );
      rpc.value = (data.rpcDetail as Record<string, unknown>) ?? data.rpc ?? {};
    } catch {
      try {
        rpc.value = await api<Record<string, unknown>>('/api/v1/rpc/status');
      } catch {
        rpc.value = {};
      }
    }
  }

  function refresh() {
    const a = routeToken.value || activeToken.value;
    if (a) {
      const lower = a.toLowerCase();
      invalidateCache(`overview:${lower}`);
      invalidateCache(`holders:${lower}`);
      invalidateCache(`chart:${lower}`);
      invalidateCache(`opportunity:${lower}`);
      invalidateCache(`risk:${lower}`);
      invalidateCache(`swaps:${lower}`);
      invalidateCache(`staking:${lower}`);
      invalidateCache(`holders:${lower}`);
    }
    refreshAt.value = Date.now();
    void loadRpc();
  }

  function setToken(addr: string) {
    activeToken.value = addr.toLowerCase();
    localStorage.setItem(ACTIVE_TOKEN_KEY, activeToken.value);
  }

  function navigateToken(path: string) {
    const addr = currentToken.value;
    if (!addr) return;
    void router.push(`/tokens/${addr}/${path}`);
  }

watch(routeToken, (addr) => {
    if (addr) {
      activeToken.value = addr;
      localStorage.setItem(ACTIVE_TOKEN_KEY, addr);
      setRealtimeChannels([`token:${addr}`, 'alerts', 'trades', 'holders']);
    }
  }, { immediate: true });

  return {
    tokens,
    apiError,
    timeRange,
    refreshAt,
    rpc,
    activeToken,
    currentToken,
    routeToken,
    loadTokens,
    importToken,
    loadRpc,
    refresh,
    setToken,
    navigateToken,
    tokenOverviewPath,
  };
}
