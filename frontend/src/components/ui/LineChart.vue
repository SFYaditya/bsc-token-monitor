<script setup lang="ts">
import { computed } from 'vue';

const props = withDefaults(
  defineProps<{
    points: { t: number; v: number }[];
    height?: number;
    stroke?: string;
    fill?: string;
  }>(),
  { height: 160, stroke: '#2563eb', fill: 'rgba(37,99,235,0.12)' },
);

const path = computed(() => {
  const pts = props.points.filter((p) => Number.isFinite(p.v) && p.v > 0);
  if (pts.length < 2) return { line: '', area: '' };
  const w = 400;
  const h = props.height;
  const minT = pts[0].t;
  const maxT = pts[pts.length - 1].t || minT + 1;
  const vals = pts.map((p) => p.v);
  const minV = Math.min(...vals) * 0.998;
  const maxV = Math.max(...vals) * 1.002 || minV + 1;
  const rangeV = maxV - minV || 1;

  const xy = pts.map((p) => {
    const x = ((p.t - minT) / (maxT - minT)) * w;
    const y = h - ((p.v - minV) / rangeV) * (h - 8) - 4;
    return [x, y];
  });

  const line = xy.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const area = `${line} L${w},${h} L0,${h} Z`;
  return { line, area };
});
</script>

<template>
  <svg
    class="chart-svg"
    :viewBox="`0 0 400 ${height}`"
    preserveAspectRatio="none"
  >
    <path v-if="path.area" :d="path.area" :fill="fill" />
    <path
      v-if="path.line"
      :d="path.line"
      fill="none"
      :stroke="stroke"
      stroke-width="2"
      vector-effect="non-scaling-stroke"
    />
    <text
      v-if="!points.length"
      x="200"
      :y="height / 2"
      text-anchor="middle"
      fill="#64748b"
      font-size="12"
    >
      暂无图表数据
    </text>
  </svg>
</template>
