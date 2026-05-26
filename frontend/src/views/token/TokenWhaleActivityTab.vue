<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../../api/client';
import { useTokenPage } from '../../composables/useTokenPage';
import { fmtTime, fmtUsd, fmtTokenAmount, bscTx } from '../../utils/format';
import { UI } from '../../utils/locale';
import CopyAddr from '../../components/ui/CopyAddr.vue';

interface WhaleActivityItem {
  id: string;
  kind: string;
  kindLabel: string;
  walletAddress: string;
  amountUsd: number;
  tokenAmount: string;
  txHash: string;
  eventTime: number;
  holdingTierLabel?: string;
  message?: string;
}

function activityBadgeClass(kind: string): string {
  if (kind.includes('buy') || kind === 'stake') return 'badge-buy';
  if (kind.includes('sell') || kind === 'unstake' || kind === 'whale_clear') return 'badge-sell';
  if (kind === 'unstake_then_sell') return 'badge-tag-unstake';
  return 'badge-whale';
}

const { addr, refreshAt } = useTokenPage();
const items = ref<WhaleActivityItem[]>([]);
const total = ref(0);
const decimals = ref(18);

async function load() {
  const r = await api<{
    items: WhaleActivityItem[];
    total: number;
    decimals: number;
  }>(`/api/v1/tokens/${addr.value}/whale-activity?limit=100&sinceHours=24`);
  items.value = r.items;
  total.value = r.total;
  decimals.value = r.decimals ?? 18;
}

watch([addr, refreshAt], load);
onMounted(load);
</script>

<template>
  <div class="space-y-4">
    <div class="page-head">
      <h1>巨鲸动态</h1>
      <p>Whale Activity · 近 24 小时大额买卖、清仓、质押与解押 · {{ total }} 条</p>
    </div>

    <div v-if="!items.length" class="glass card-pad text-muted">暂无巨鲸相关动态</div>
    <div v-else class="space-y-2">
      <div
        v-for="ev in items"
        :key="ev.id"
        class="glass card-pad flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="min-w-0 flex-1 space-y-1">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge" :class="activityBadgeClass(ev.kind)">{{ ev.kindLabel }}</span>
            <span v-if="ev.holdingTierLabel" class="badge badge-whale">{{ ev.holdingTierLabel }}</span>
            <span class="text-sm font-semibold" :class="ev.kind.includes('buy') || ev.kind === 'stake' ? 'up' : 'down'">
              {{ fmtUsd(ev.amountUsd) }}
            </span>
          </div>
          <CopyAddr :address="ev.walletAddress" />
          <p v-if="ev.message" class="text-muted text-xs">{{ ev.message }}</p>
          <p v-if="ev.tokenAmount && ev.tokenAmount !== '0'" class="text-muted text-xs">
            {{ fmtTokenAmount(ev.tokenAmount, decimals) }} 枚
          </p>
        </div>
        <div class="shrink-0 text-right text-xs text-muted">
          <div>{{ fmtTime(ev.eventTime) }}</div>
          <a
            v-if="ev.txHash"
            class="link mt-1 inline-block"
            :href="bscTx(ev.txHash)"
            target="_blank"
            rel="noopener"
          >{{ UI.viewOnChain }}</a>
        </div>
      </div>
    </div>
  </div>
</template>
