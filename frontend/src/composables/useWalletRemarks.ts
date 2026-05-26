import { ref, watch, type Ref } from 'vue';
import { api, apiRaw } from '../api/client';

export function useWalletRemarks(tokenAddr: Ref<string>) {
  const remarks = ref<Record<string, string>>({});
  const loading = ref(false);

  async function load(): Promise<void> {
    const token = tokenAddr.value.toLowerCase();
    if (!token) {
      remarks.value = {};
      return;
    }
    loading.value = true;
    try {
      const r = await api<{ items: { wallet_address: string; remark: string }[] }>(
        `/api/v1/tokens/${token}/wallet-remarks`,
      );
      const map: Record<string, string> = {};
      for (const row of r.items ?? []) {
        const w = String(row.wallet_address ?? '').toLowerCase();
        const text = String(row.remark ?? '').trim();
        if (w && text) map[w] = text;
      }
      remarks.value = map;
    } finally {
      loading.value = false;
    }
  }

  function labelFor(wallet: string): string | undefined {
    return remarks.value[wallet.toLowerCase()];
  }

  async function saveRemark(wallet: string, remark: string): Promise<void> {
    const token = tokenAddr.value.toLowerCase();
    const w = wallet.toLowerCase();
    const text = remark.trim();
    if (!text) {
      await apiRaw(`/api/v1/tokens/${token}/addresses/${w}/remark`, { method: 'DELETE' });
      const next = { ...remarks.value };
      delete next[w];
      remarks.value = next;
      return;
    }
    await api(`/api/v1/tokens/${token}/addresses/${w}/remark`, {
      method: 'PUT',
      body: JSON.stringify({ remark: text }),
    });
    remarks.value = { ...remarks.value, [w]: text };
  }

  watch(tokenAddr, () => void load(), { immediate: true });

  return { remarks, loading, load, labelFor, saveRemark };
}
