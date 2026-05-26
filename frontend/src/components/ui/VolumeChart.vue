<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(defineProps<{ bars: { t: number; buyUsd: number; sellUsd: number }[]; height?: number }>(), {
  height: 120,
});

const rendered = computed(() => {
  const bars = props.bars;
  if (!bars.length) return [];
  const max = Math.max(...bars.map((b) => b.buyUsd + b.sellUsd), 1);
  const w = 400;
  const gap = 2;
  const barW = Math.max(2, w / bars.length - gap);
  return bars.map((b, i) => {
    const total = b.buyUsd + b.sellUsd;
    const hTotal = (total / max) * (props.height - 16);
    const hBuy = total > 0 ? (b.buyUsd / total) * hTotal : 0;
    const hSell = hTotal - hBuy;
    return {
      x: i * (barW + gap),
      w: barW,
      hBuy,
      hSell,
      yBase: props.height - 4,
    };
  });
});
</script>

<template>
  <svg class="chart-svg" :viewBox="`0 0 400 ${height}`" preserveAspectRatio="none">
    <g v-for="(b, i) in rendered" :key="i">
      <rect
        :x="b.x"
        :y="b.yBase - b.hSell"
        :width="b.w"
        :height="b.hSell"
        fill="#ef4444"
        opacity="0.85"
      />
      <rect
        :x="b.x"
        :y="b.yBase - b.hSell - b.hBuy"
        :width="b.w"
        :height="b.hBuy"
        fill="#22c55e"
        opacity="0.85"
      />
    </g>
    <text v-if="!bars.length" x="200" :y="height / 2" text-anchor="middle" fill="#64748b" font-size="12">
      暂无成交量数据
    </text>
  </svg>
</template>
