<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import { api } from '../../api/client';
import { fmtTimeShort, fmtUsd } from '../../utils/format';
import { UI, zhAlertLevel } from '../../utils/locale';
import { formatAlertTypeDisplay } from '../../utils/alertDisplay';
import { useAppStore } from '../../composables/useAppStore';
import CopyAddr from '../ui/CopyAddr.vue';
import { useRealtime } from '../../composables/useRealtime';

const { refreshAt, currentToken } = useAppStore();
const items = ref<Record<string, unknown>[]>([]);

function isRpcOpsAlert(row: Record<string, unknown>): boolean {
  return String(row.alert_type ?? '').startsWith('rpc_');
}

async function load() {
  const q = currentToken.value ? `?pageSize=40&token=${currentToken.value}` : '?pageSize=40';
  const res = await api<{ items: Record<string, unknown>[] }>(`/api/v1/alerts${q}`);
  items.value = res.items.filter((a) => !isRpcOpsAlert(a));
}

function alertTags(row: Record<string, unknown>) {
  return formatAlertTypeDisplay(String(row.alert_type), row.amount_usd);
}

function alertBadge(type: string): string {
  const t = type.toLowerCase();
  if (t.includes('buy') || t.includes('买')) return 'badge-buy';
  if (t.includes('sell') || t.includes('卖') || t.includes('clear')) return 'badge-sell';
  if (t.includes('whale') || t.includes('鲸')) return 'badge-whale';
  if (t.includes('liq') || t.includes('流动')) return 'badge-liq';
  return 'badge-warn';
}

let timer: ReturnType<typeof setInterval>;
onMounted(() => {
  void load();
  timer = setInterval(load, 10000);
});
onUnmounted(() => clearInterval(timer));
watch([refreshAt, currentToken], () => void load());

useRealtime((msg) => {
  if (msg.type !== 'alert_event') return;
  const data = (msg.data ?? msg) as Record<string, unknown>;
  const alertType = String(data.alertType ?? data.alert_type ?? '');
  if (alertType.startsWith('rpc_')) return;
  if (currentToken.value && String(msg.tokenAddress ?? '').toLowerCase() !== currentToken.value) {
    return;
  }
  const id = String(data.id ?? `ws-${Date.now()}`);
  if (items.value.some((a) => String(a.id) === id)) return;
  items.value = [
    {
      id,
      alert_type: data.alertType ?? data.alert_type ?? 'alert',
      level: data.level ?? 'INFO',
      token_address: msg.tokenAddress ?? data.token_address,
      wallet_address: data.walletAddress ?? data.wallet_address,
      amount_usd: data.amountUsd ?? data.amount_usd,
      trade_size_label: data.tradeSizeLabel ?? data.trade_size_label,
      message: data.message,
      created_at: data.createdAt ?? data.created_at ?? Date.now(),
    },
    ...items.value,
  ].slice(0, 40);
});
</script>

<template>
  <aside class="shell-alerts">
    <div class="card-pad flex items-center justify-between border-b border-[var(--border)]">
      <div class="flex items-center gap-2">
        <span class="pulse-live" />
        <span class="text-sm font-semibold">实时告警</span>
      </div>
      <RouterLink to="/settings" class="link text-xs">全部</RouterLink>
    </div>
    <div v-if="!items.length" class="alert-item text-muted">暂无实时告警</div>
    <div v-for="a in items" :key="String(a.id)" class="alert-item">
      <div class="alert-time">{{ fmtTimeShort(Number(a.created_at)) }}</div>
      <div class="mb-1 flex flex-wrap gap-1">
        <template v-if="alertTags(a).isTrade">
          <span class="badge" :class="alertTags(a).sideClass">{{ alertTags(a).sideLabel }}</span>
          <span class="badge" :class="alertTags(a).sizeClass">{{ alertTags(a).sizeLabel }}</span>
        </template>
        <span v-else class="badge" :class="alertBadge(String(a.alert_type))">
          {{ alertTags(a).fallbackLabel }}
        </span>
        <span v-if="a.level" class="badge badge-neutral">{{ zhAlertLevel(String(a.level)) }}</span>
      </div>
      <p v-if="a.token_address" class="mb-1">
        <RouterLink class="link text-xs" :to="`/tokens/${a.token_address}/overview`">
          {{ UI.viewToken }}
        </RouterLink>
      </p>
      <p v-if="a.wallet_address" class="mb-1">
        <CopyAddr
          v-if="a.wallet_address"
          :address="String(a.wallet_address)"
          :token="String(a.token_address ?? currentToken ?? '')"
        />
      </p>
      <p v-if="a.amount_usd" class="text-secondary">{{ fmtUsd(Number(a.amount_usd)) }}</p>
    </div>
  </aside>
</template>
