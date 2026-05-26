<script setup lang="ts">
const props = defineProps<{
  addressType?: string | null;
  isContract?: boolean | number | null;
}>();

const isContractAddr =
  props.isContract === true ||
  props.isContract === 1 ||
  props.addressType === 'contract';
</script>

<template>
  <span v-if="isContractAddr" class="badge badge-neutral shrink-0">合约</span>
</template>
