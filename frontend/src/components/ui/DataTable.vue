<script setup lang="ts">
import { computed, ref, watch } from 'vue';

export type Column = {
  key: string;
  label: string;
  sortable?: boolean;
  align?: 'left' | 'right';
  sortType?: 'number' | 'bigint' | 'string';
  format?: (row: Record<string, unknown>) => string;
};

const props = defineProps<{
  columns: Column[];
  rows: Record<string, unknown>[];
  rowKey?: string;
  pageSize?: number;
  defaultSortKey?: string;
  defaultSortDir?: 1 | -1;
  /** 为 true 时仅通过 sort 事件由父组件排序，不在本地 sort */
  serverSort?: boolean;
  /** 为 false 时不切片、不显示内部分页（由父组件服务端分页） */
  paginate?: boolean;
}>();

const emit = defineEmits<{
  sort: [{ key: string; dir: 1 | -1 }];
}>();

const sortKey = ref(props.defaultSortKey ?? '');
const sortDir = ref<1 | -1>(props.defaultSortDir ?? -1);
const page = ref(1);

watch(
  () => [props.defaultSortKey, props.defaultSortDir] as const,
  ([key, dir]) => {
    if (key) sortKey.value = key;
    if (dir) sortDir.value = dir;
  },
);

function cellSortValue(row: Record<string, unknown>, k: string): unknown {
  if (k === 'balance') return row.balanceRaw ?? row.balance ?? row[k];
  if (k === 'net_buy') return row.net_buy_amount ?? row.net_buy ?? row[k];
  return row[k];
}

function compareRows(a: Record<string, unknown>, b: Record<string, unknown>, k: string): number {
  const col = props.columns.find((c) => c.key === k);
  const av = cellSortValue(a, k);
  const bv = cellSortValue(b, k);
  if (col?.sortType === 'bigint' || k === 'balance' || k === 'net_buy') {
    const ba = BigInt(String(av ?? '0'));
    const bb = BigInt(String(bv ?? '0'));
    if (bb > ba) return 1;
    if (bb < ba) return -1;
    return 0;
  }
  const na = Number(av);
  const nb = Number(bv);
  if (Number.isFinite(na) && Number.isFinite(nb)) {
    if (na > nb) return 1;
    if (na < nb) return -1;
    return 0;
  }
  return String(av ?? '').localeCompare(String(bv ?? ''));
}

const sorted = computed(() => {
  let list = [...props.rows];
  if (!props.serverSort && sortKey.value) {
    const k = sortKey.value;
    list.sort((a, b) => compareRows(a, b, k) * sortDir.value);
  }
  return list;
});

const paginateEnabled = computed(() => props.paginate !== false);

const paged = computed(() => {
  if (!paginateEnabled.value) return sorted.value;
  const size = props.pageSize ?? 20;
  const start = (page.value - 1) * size;
  return sorted.value.slice(start, start + size);
});

const totalPages = computed(() => {
  if (!paginateEnabled.value) return 1;
  const size = props.pageSize ?? 20;
  return Math.max(1, Math.ceil(sorted.value.length / size));
});

function toggleSort(col: Column) {
  if (!col.sortable) return;
  if (sortKey.value === col.key) sortDir.value = (sortDir.value * -1) as 1 | -1;
  else {
    sortKey.value = col.key;
    sortDir.value = -1;
  }
  page.value = 1;
  emit('sort', { key: col.key, dir: sortDir.value });
}

function cell(row: Record<string, unknown>, col: Column): string {
  if (col.format) return col.format(row);
  return String(row[col.key] ?? '—');
}
</script>

<template>
  <div class="desktop-table table-wrap">
    <table class="data-table">
      <thead>
        <tr>
          <th
            v-for="col in columns"
            :key="col.key"
            :style="{ textAlign: col.align ?? 'left' }"
            @click="toggleSort(col)"
          >
            {{ col.label }}
            <span v-if="col.sortable && sortKey === col.key">{{ sortDir > 0 ? '↑' : '↓' }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in paged" :key="String(row[rowKey ?? 'id'] ?? row)">
          <td
            v-for="col in columns"
            :key="col.key"
            :style="{ textAlign: col.align ?? 'left' }"
          >
            <slot :name="`cell-${col.key}`" :row="row">{{ cell(row, col) }}</slot>
          </td>
        </tr>
        <tr v-if="!paged.length">
          <td :colspan="columns.length" class="table-empty">暂无数据</td>
        </tr>
      </tbody>
    </table>
    <div v-if="paginateEnabled && totalPages > 1" class="mt-3 flex justify-end gap-2">
      <button class="btn btn-sm" :disabled="page <= 1" @click="page--">上一页</button>
      <span class="text-muted self-center text-xs">{{ page }} / {{ totalPages }}</span>
      <button class="btn btn-sm" :disabled="page >= totalPages" @click="page++">下一页</button>
    </div>
  </div>

  <div class="mobile-cards">
    <div v-for="row in paged" :key="String(row[rowKey ?? 'id'])" class="mobile-card">
      <slot name="mobile-card" :row="row">
        <div v-for="col in columns" :key="col.key" class="mobile-card-row">
          <span class="text-muted">{{ col.label }}</span>
          <span><slot :name="`cell-${col.key}`" :row="row">{{ cell(row, col) }}</slot></span>
        </div>
      </slot>
    </div>
  </div>
</template>
