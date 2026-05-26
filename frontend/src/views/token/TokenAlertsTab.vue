<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { api } from '../../api/client';
import { useTokenPage } from '../../composables/useTokenPage';
import { fmtTimeShort, fmtUsd, bscTx } from '../../utils/format';
import { UI, zhAlertLevel } from '../../utils/locale';
import { formatAlertTypeDisplay } from '../../utils/alertDisplay';
import DataTable from '../../components/ui/DataTable.vue';
import CopyAddr from '../../components/ui/CopyAddr.vue';
import { useRealtime } from '../../composables/useRealtime';

const { addr, refreshAt } = useTokenPage();
const items = ref<Record<string, unknown>[]>([]);

async function load() {
  const r = await api<{ items: Record<string, unknown>[] }>(
    `/api/v1/alerts?token=${addr.value}&pageSize=100`,
  );
  items.value = r.items;
}

watch([addr, refreshAt], load);
onMounted(load);

useRealtime((msg) => {
  if (msg.type !== 'alert_event') return;
  if (String(msg.tokenAddress ?? '').toLowerCase() !== addr.value) return;
  void load();
});
</script>

<template>
  <div class="space-y-4">
    <div class="page-head">
      <h1>告警</h1>
      <p>该代币相关告警信号</p>
    </div>
    <div class="glass card-pad">
      <DataTable
        :columns="[
          { key: 'created_at', label: '时间', sortable: true },
          { key: 'alert_type', label: '类型' },
          { key: 'level', label: '等级' },
          { key: 'amount_usd', label: '金额', sortable: true, align: 'right' },
        ]"
        :rows="items"
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
        <template #cell-level="{ row }">{{ zhAlertLevel(String(row.level)) }}</template>
        <template #cell-amount_usd="{ row }">{{ fmtUsd(Number(row.amount_usd ?? 0)) }}</template>
        <template #mobile-card="{ row }">
          <div class="mobile-card-row">
            <span>{{ fmtTimeShort(Number(row.created_at)) }}</span>
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
          </div>
          <CopyAddr v-if="row.wallet_address" :address="String(row.wallet_address)" />
          <a v-if="row.tx_hash" class="link text-xs" :href="bscTx(String(row.tx_hash))" target="_blank">{{ UI.viewOnChain }}</a>
        </template>
      </DataTable>
    </div>
  </div>
</template>
