<script setup lang="ts">
import { ref, computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { shortAddr, copyText, bscAddr } from '../../utils/format';
import { UI } from '../../utils/locale';

const props = withDefaults(
  defineProps<{
    address: string;
    /** 代币合约；未传时从当前路由 tokens/:address 推断 */
    token?: string | null;
    remark?: string | null;
    /** 点击地址跳转详情页；默认 true（有 token 上下文时） */
    toDetail?: boolean;
    /** 点击打开 BscScan */
    external?: boolean;
    /** @deprecated 使用 external */
    href?: boolean;
  }>(),
  {
    toDetail: true,
    external: false,
    href: false,
  },
);

const route = useRoute();

const tokenAddr = computed(() => {
  const explicit = props.token?.trim();
  if (explicit) return explicit.toLowerCase();
  const fromRoute = route.params.address;
  if (fromRoute) return String(fromRoute).toLowerCase();
  return null;
});

const walletAddr = computed(() => String(props.address ?? '').toLowerCase());

const detailPath = computed(() => {
  if (props.toDetail === false) return null;
  if (!tokenAddr.value || !walletAddr.value) return null;
  return `/tokens/${tokenAddr.value}/address/${walletAddr.value}`;
});

const useExternal = computed(() => props.external || props.href);

const display = computed(() => {
  const note = props.remark?.trim();
  return note || shortAddr(props.address);
});

const copied = ref(false);

async function onCopy(e: Event) {
  e.preventDefault();
  e.stopPropagation();
  const ok = await copyText(props.address);
  if (ok) {
    copied.value = true;
    setTimeout(() => {
      copied.value = false;
    }, 1500);
  }
}
</script>

<template>
  <span class="inline-flex items-center gap-1" :title="address">
    <a
      v-if="useExternal"
      class="addr link"
      :href="bscAddr(address)"
      target="_blank"
      rel="noopener"
      @click.stop
    >
      {{ display }}
    </a>
    <RouterLink v-else-if="detailPath" class="addr link" :to="detailPath">
      {{ display }}
    </RouterLink>
    <button v-else type="button" class="addr border-0 bg-transparent p-0" @click="onCopy">
      {{ display }}
    </button>
    <button
      type="button"
      class="btn btn-ghost btn-sm !h-6 !min-w-0 px-1 text-muted"
      :title="copied ? UI.copied : UI.copy"
      @click="onCopy"
    >
      {{ copied ? '✓' : '⎘' }}
    </button>
  </span>
</template>
