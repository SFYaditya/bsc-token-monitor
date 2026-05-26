<script setup lang="ts">
import {
  tierBadgeClass,
  impactBadgeClass,
  tagBadgeClass,
  type GradingPayload,
} from '../../utils/whaleGrading';

defineProps<{
  grading: GradingPayload | null | undefined;
  compact?: boolean;
}>();
</script>

<template>
  <div v-if="grading" class="flex flex-wrap gap-1.5" :class="compact ? 'text-xs' : ''">
    <span class="badge" :class="tierBadgeClass(grading.holdingTier)" :title="`持仓 ${grading.holdingUsd.toFixed(2)} 美元`">
      {{ grading.holdingTierLabel }}
    </span>
    <span
      class="badge badge-neutral"
      :class="impactBadgeClass(grading.liquidityImpact)"
      :title="`占流动性 ${grading.liquidityImpactPct.toFixed(2)}%`"
    >
      {{ grading.liquidityImpactLabel }}
    </span>
    <span
      v-for="(tag, i) in grading.behaviorTags"
      :key="tag"
      class="badge"
      :class="tagBadgeClass(tag)"
    >
      {{ grading.behaviorTagLabels[i] }}
    </span>
  </div>
</template>
