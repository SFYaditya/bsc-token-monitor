<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { api } from '../api/client';
import { useRealtime } from '../composables/useRealtime';
import { useWalletRemarks } from '../composables/useWalletRemarks';
import { useTokenPage } from '../composables/useTokenPage';
import { bscTx, fmtTime, fmtUsd, fmtEventType, fmtAddressLabel, fmtTokenAmount } from '../utils/format';
import { UI } from '../utils/locale';
import CopyAddr from '../components/ui/CopyAddr.vue';
import DataTable from '../components/ui/DataTable.vue';
import WhaleBadges from '../components/ui/WhaleBadges.vue';
import type { GradingPayload } from '../utils/whaleGrading';
import { patchFromNewTrade } from '../utils/tradeBalance';

const route = useRoute();
const token = computed(() => String(route.params.address).toLowerCase());
const wallet = computed(() => String(route.params.wallet).toLowerCase());
const profile = ref<Record<string, unknown> | null>(null);
const grading = ref<GradingPayload | null>(null);
const trades = ref<Record<string, unknown>[]>([]);
const staking = ref<Record<string, unknown>[]>([]);
const remark = ref('');
const remarkInput = ref('');
const remarkMsg = ref('');
const savingRemark = ref(false);
const quoteSymbol = ref('USDT');
const quoteDecimals = ref(18);

const { saveRemark: persistRemark } = useWalletRemarks(token);
const { decimals } = useTokenPage();

const quoteBalanceLabel = computed(() => `交易后 ${quoteSymbol.value}`);

function mapTradeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    let eventType = String(row.event_type ?? row.trade_type ?? '').toLowerCase();
    if (eventType !== 'buy' && eventType !== 'sell') {
      const side = String(row.side ?? '').toLowerCase();
      if (side.includes('buy')) eventType = 'buy';
      else if (side.includes('sell')) eventType = 'sell';
    }
    return {
      ...row,
      id: row.id ?? `${row.tx_hash}-${row.log_index ?? 0}`,
      event_time: Number(row.event_time ?? row.block_time ?? 0),
      event_type: eventType,
    };
  });
}

const labels = computed(() => {
  const l = profile.value?.labels;
  return Array.isArray(l) ? (l as string[]).map((x) => fmtAddressLabel(x)) : [];
});

async function load() {
  const data = await api<{
    profile: Record<string, unknown>;
    trades: Record<string, unknown>[];
    grading?: GradingPayload | null;
    remark?: string | null;
    quoteSymbol?: string;
    quoteDecimals?: number;
  }>(`/api/v1/tokens/${token.value}/addresses/${wallet.value}`);
  profile.value = data.profile;
  grading.value = data.grading ?? null;
  if (data.quoteSymbol) quoteSymbol.value = data.quoteSymbol;
  if (data.quoteDecimals != null) quoteDecimals.value = data.quoteDecimals;
  trades.value = mapTradeRows(data.trades ?? []);
  remark.value = String(data.remark ?? '').trim();
  remarkInput.value = remark.value;
  try {
    const st = await api<{ items: Record<string, unknown>[] }>(
      `/api/v1/tokens/${token.value}/staking?pageSize=50`,
    );
    staking.value = (st.items ?? []).filter(
      (r) =>
        String(r.wallet_address ?? r.from_address ?? '').toLowerCase() === wallet.value,
    );
  } catch {
    staking.value = [];
  }
}

async function saveRemark() {
  remarkMsg.value = '';
  savingRemark.value = true;
  try {
    await persistRemark(wallet.value, remarkInput.value);
    remark.value = remarkInput.value.trim();
    remarkMsg.value = remark.value ? '备注已保存，TG 推送将显示此名称' : '备注已删除';
  } catch (e) {
    remarkMsg.value = e instanceof Error ? e.message : '保存失败';
  } finally {
    savingRemark.value = false;
  }
}

async function deleteRemark() {
  remarkInput.value = '';
  await saveRemark();
}

watch(() => [route.params.address, route.params.wallet], load);
onMounted(load);

useRealtime((msg) => {
  if (msg.type !== 'new_trade') return;
  if (String(msg.tokenAddress ?? '').toLowerCase() !== token.value) return;
  const data = (msg.data ?? msg) as Record<string, unknown>;
  const trader = String(data.walletAddress ?? '').toLowerCase();
  if (trader !== wallet.value) return;
  const patch = patchFromNewTrade(data);
  if (profile.value && patch) {
    profile.value = {
      ...profile.value,
      walletBalance: patch.balanceRaw,
      buyCount: patch.buyCount,
      sellCount: patch.sellCount,
      lastTradeTime: patch.lastTradeTime ?? profile.value.lastTradeTime,
    };
  }
  const quoteAfter = data.quoteBalanceAfter ?? data.quote_balance_after;
  if (
    profile.value &&
    quoteSymbol.value === 'USDT' &&
    quoteAfter != null &&
    String(quoteAfter) !== ''
  ) {
    profile.value = { ...profile.value, usdtBalance: String(quoteAfter) };
  }
  void load();
});
</script>

<template>
  <div v-if="profile" class="space-y-4">
    <div class="page-head">
      <h1 class="font-mono text-base">地址画像</h1>
      <CopyAddr :address="wallet" :to-detail="false" external :remark="remark" />
      <div class="mt-3 space-y-2">
        <WhaleBadges v-if="grading" :grading="grading" />
        <div class="flex flex-wrap gap-2">
          <span v-if="profile.isWhale" class="badge badge-whale">巨鲸</span>
          <span v-for="l in labels" :key="l" class="badge badge-neutral">{{ l }}</span>
        </div>
      </div>
    </div>

    <div class="glass card-pad">
      <h3 class="card-title">地址备注</h3>
      <p class="text-muted mb-3 text-xs">保存后 TG 买卖通知「地址」行将显示备注；未设置则显示短地址（前4后6）</p>
      <div class="flex flex-wrap items-center gap-2">
        <input
          v-model="remarkInput"
          class="input min-w-[12rem] flex-1"
          maxlength="64"
          placeholder="例如：大户 A、项目方关联"
        />
        <button type="button" class="btn btn-primary" :disabled="savingRemark" @click="saveRemark">
          {{ savingRemark ? '保存中…' : '保存' }}
        </button>
        <button
          v-if="remark || remarkInput"
          type="button"
          class="btn btn-default"
          :disabled="savingRemark"
          @click="deleteRemark"
        >
          删除
        </button>
      </div>
      <p v-if="remarkMsg" class="text-muted mt-2 text-sm">{{ remarkMsg }}</p>
    </div>

    <div class="stat-row">
      <div class="glass card-pad">
        <div class="metric-label">当前持仓</div>
        <div class="metric-value-sm amount-stack amount-stack--start">
          <span class="amount-stack__primary">
            {{ fmtTokenAmount(String(profile.walletBalance ?? '0'), decimals, 4) }}
          </span>
          <span class="amount-stack__accent">
            占比 {{ Number(profile.balancePercent ?? 0).toFixed(4) }}%
          </span>
        </div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">USDT 持仓</div>
        <div class="metric-value-sm">
          <span v-if="profile.usdtBalance != null && String(profile.usdtBalance) !== ''">
            {{ fmtTokenAmount(String(profile.usdtBalance), 18, 4) }}
          </span>
          <span v-else class="text-muted">—</span>
        </div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">质押数量</div>
        <div class="metric-value-sm">{{ fmtTokenAmount(String(profile.stakingBalance ?? '0'), decimals, 4) }}</div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">LP</div>
        <div class="space-y-2 text-sm">
          <div>
            <span class="text-muted">持仓 </span>
            <span class="font-medium tabular-nums">
              {{ fmtTokenAmount(String(profile.lpBalanceRaw ?? '0'), decimals, 4) }}
            </span>
            <span
              v-if="Number(profile.lpBalanceUsd ?? 0) > 0"
              class="text-secondary ml-1"
            >
              · {{ fmtUsd(Number(profile.lpBalanceUsd)) }}
            </span>
          </div>
          <div>
            <span class="text-muted">质押 </span>
            <span class="font-medium tabular-nums">
              {{ fmtTokenAmount(String(profile.lpStakedBalanceRaw ?? '0'), decimals, 4) }}
            </span>
            <span
              v-if="Number(profile.lpStakedBalanceUsd ?? 0) > 0"
              class="text-secondary ml-1"
            >
              · {{ fmtUsd(Number(profile.lpStakedBalanceUsd)) }}
            </span>
          </div>
        </div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">累计买卖</div>
        <div class="space-y-1 text-sm">
          <div class="up">买 {{ profile.buyCount }} 次 · {{ fmtUsd(Number(profile.totalBuyUsd)) }}</div>
          <div class="down">卖 {{ profile.sellCount }} 次 · {{ fmtUsd(Number(profile.totalSellUsd)) }}</div>
        </div>
      </div>
      <div class="glass card-pad">
        <div class="metric-label">净买入</div>
        <div :class="Number(profile.netBuyUsd) >= 0 ? 'up' : 'down'">{{ fmtUsd(Number(profile.netBuyUsd)) }}</div>
      </div>
    </div>

    <div class="glass card-pad">
      <h3 class="card-title">盈亏画像</h3>
      <div class="grid gap-2 text-sm text-secondary sm:grid-cols-2">
        <p>平均买入价：{{ Number(profile.avgBuyPrice ?? 0).toFixed(4) }}</p>
        <p>平均卖出价：{{ Number(profile.avgSellPrice ?? 0).toFixed(4) }}</p>
        <p>浮盈：{{ fmtUsd(Number(profile.unrealizedPnl ?? 0)) }}</p>
        <p>已实现：{{ fmtUsd(Number(profile.realizedPnl ?? 0)) }}</p>
        <p>{{ UI.roi }}：{{ Number(profile.roi ?? 0).toFixed(4) }}%</p>
        <p>已清仓：{{ profile.isCleared ? '是' : '否' }}</p>
        <p>首次买入：{{ profile.firstBuyTime ? fmtTime(Number(profile.firstBuyTime)) : '—' }}</p>
        <p>最近交易：{{ profile.lastTradeTime ? fmtTime(Number(profile.lastTradeTime)) : '—' }}</p>
      </div>
    </div>

    <div class="glass card-pad">
      <h3 class="card-title">交易历史</h3>
      <DataTable
        :columns="[
          { key: 'event_time', label: UI.time, sortable: true },
          { key: 'event_type', label: UI.type },
          { key: 'amount_usd', label: UI.usd, sortable: true, align: 'right' },
          { key: 'quote_balance_after', label: quoteBalanceLabel, align: 'right' },
        ]"
        :rows="trades"
        row-key="id"
        :page-size="15"
      >
        <template #cell-event_time="{ row }">{{ fmtTime(Number(row.event_time)) }}</template>
        <template #cell-event_type="{ row }">
          <span
            class="badge"
            :class="String(row.event_type).toLowerCase() === 'buy' ? 'badge-buy' : 'badge-sell'"
          >
            {{ fmtEventType(String(row.event_type)) }}
          </span>
        </template>
        <template #cell-amount_usd="{ row }">{{ fmtUsd(Number(row.amount_usd ?? 0)) }}</template>
        <template #cell-quote_balance_after="{ row }">
          <span v-if="row.quote_balance_after != null && String(row.quote_balance_after) !== ''">
            {{ fmtTokenAmount(String(row.quote_balance_after), quoteDecimals, 4) }}
          </span>
          <span v-else class="text-muted">—</span>
        </template>
        <template #mobile-card="{ row }">
          <div class="mobile-card-row">
            <span>{{ fmtEventType(String(row.event_type)) }}</span>
            <span>{{ fmtUsd(Number(row.amount_usd ?? 0)) }}</span>
          </div>
          <div class="mobile-card-row text-secondary text-xs">
            {{ quoteBalanceLabel }}
            {{
              row.quote_balance_after != null && String(row.quote_balance_after) !== ''
                ? fmtTokenAmount(String(row.quote_balance_after), quoteDecimals, 4)
                : '—'
            }}
          </div>
          <a class="link text-xs" :href="bscTx(String(row.tx_hash))" target="_blank" rel="noopener">{{ UI.viewOnChain }}</a>
        </template>
      </DataTable>
    </div>

    <div v-if="staking.length" class="glass card-pad">
      <h3 class="card-title">质押历史</h3>
      <DataTable
        :columns="[
          { key: 'event_time', label: UI.time, sortable: true },
          { key: 'event_type', label: UI.type },
        ]"
        :rows="staking"
        row-key="id"
      >
        <template #cell-event_time="{ row }">{{ fmtTime(Number(row.event_time)) }}</template>
        <template #cell-event_type="{ row }">
          <span class="badge badge-stake">{{ fmtEventType(String(row.event_type)) }}</span>
        </template>
      </DataTable>
    </div>
  </div>
  <div v-else class="loading">{{ UI.loading }}</div>
</template>