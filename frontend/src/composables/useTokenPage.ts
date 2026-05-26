import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/client';
import { cachedFetch, peekCache } from '../utils/requestCache';
import { overviewCacheKey } from './useTokenPrefetch';
import { useAppStore } from './useAppStore';

const contractByAddr = ref<Record<string, Record<string, unknown>>>({});

export function useTokenPage() {
  const route = useRoute();
  const { timeRange, refreshAt } = useAppStore();

  const addr = computed(() => String(route.params.address).toLowerCase());
  const loading = ref(true);

  const contract = computed(() => contractByAddr.value[addr.value] ?? null);
  const decimals = computed(() => Number(contract.value?.token_decimals ?? 18));

  async function fetchOverview() {
    return api<{
      contract: Record<string, unknown>;
      overview: Record<string, unknown>;
      status_label: string;
    }>(`/api/v1/tokens/${addr.value}/overview`);
  }

  async function loadContractMeta() {
    const key = overviewCacheKey(addr.value);
    const cached = peekCache<Awaited<ReturnType<typeof fetchOverview>>>(key, 120_000);
    if (cached?.contract) {
      contractByAddr.value = {
        ...contractByAddr.value,
        [addr.value]: cached.contract,
      };
      loading.value = false;
      if (peekCache(key, 15_000)) return;
    } else {
      loading.value = true;
    }
    try {
      const data = await cachedFetch(key, fetchOverview, 120_000);
      contractByAddr.value = {
        ...contractByAddr.value,
        [addr.value]: data.contract,
      };
    } finally {
      loading.value = false;
    }
  }

  watch([addr, refreshAt], () => void loadContractMeta(), { immediate: true });

  return { addr, timeRange, refreshAt, loading, contract, decimals, fetchOverview, loadContractMeta };
}
