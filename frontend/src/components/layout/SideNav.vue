<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import { useAppStore } from '../../composables/useAppStore';

const route = useRoute();
const { currentToken, tokens } = useAppStore();

const tokenSymbol = computed(() => {
  const addr = currentToken.value;
  if (!addr) return '';
  const row = tokens.value.find(
    (t) => String(t.contract_address).toLowerCase() === addr,
  );
  return row ? String(row.token_symbol ?? '').toUpperCase() : '';
});

const tokenLinks = computed(() => {
  const addr = currentToken.value;
  if (!addr) return [];
  const base = `/tokens/${addr}`;
  return [
    { to: `${base}/overview`, label: '总览', icon: '◉' },
    { to: `${base}/trades`, label: '买卖', icon: '⇄' },
    { to: `${base}/holders`, label: '持仓榜', icon: '◎' },
    { to: `${base}/whale-activity`, label: '巨鲸动态', icon: '🐋' },
    { to: `${base}/staking`, label: '质押', icon: '⬡' },
    { to: `${base}/liquidity`, label: '流动性', icon: '◈' },
    { to: `${base}/alerts`, label: '告警', icon: '⚡' },
  ];
});

function isActive(path: string): boolean {
  if (path.endsWith('/overview')) {
    return route.path === path;
  }
  return route.path === path || route.path.startsWith(path + '/');
}
</script>

<template>
  <nav class="sidenav shell-side">
    <div v-if="currentToken" class="sidenav-section">
      <div class="sidenav-label">{{ tokenSymbol || '代币' }}</div>
      <RouterLink
        v-for="link in tokenLinks"
        :key="link.to"
        :to="link.to"
        class="sidenav-link"
        :class="{ 'sidenav-link-active': isActive(link.to) }"
      >
        <span class="sidenav-icon">{{ link.icon }}</span>
        {{ link.label }}
      </RouterLink>
    </div>

    <div class="sidenav-section">
      <div class="sidenav-label">系统</div>
      <RouterLink
        to="/settings"
        class="sidenav-link"
        :class="{ 'sidenav-link-active': route.path === '/settings' }"
      >
        <span class="sidenav-icon">⚙</span>
        设置
      </RouterLink>
    </div>
  </nav>
</template>
