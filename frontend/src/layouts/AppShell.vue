<script setup lang="ts">
import { onMounted, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import TopBar from '../components/layout/TopBar.vue';
import SideNav from '../components/layout/SideNav.vue';
import AlertPanel from '../components/layout/AlertPanel.vue';
import { useAppStore, defaultTokenPath } from '../composables/useAppStore';
import { setRealtimeChannels } from '../composables/useRealtime';

const route = useRoute();
const router = useRouter();
const { loadTokens, currentToken, apiError } = useAppStore();

async function bootstrap() {
  await loadTokens();
  const addr = currentToken.value;
  if (addr) {
    setRealtimeChannels([`token:${addr}`, 'alerts', 'trades', 'holders']);
  } else {
    setRealtimeChannels(['alerts']);
  }
  if (addr && (route.path === '/' || route.path === '/tokens' || route.path === '/dashboard')) {
    await router.replace(defaultTokenPath());
  }
}

onMounted(() => void bootstrap());

watch(
  () => route.path,
  (path) => {
    if (path === '/tokens' && currentToken.value) {
      void router.replace(defaultTokenPath());
    }
  },
);
</script>

<template>
  <div class="shell">
    <TopBar />
    <SideNav />
    <main class="shell-main">
      <div
        v-if="apiError"
        class="mx-4 mt-3 rounded border border-[var(--red)] bg-[var(--red-dim)] px-3 py-2 text-sm text-[var(--red)]"
      >
        后端不可用：{{ apiError }}。请确认 Docker 中 api 服务已启动（docker compose ps）。
      </div>
      <RouterView v-slot="{ Component, route: r }">
        <keep-alive :max="12">
          <component :is="Component" v-if="Component" :key="r.fullPath" />
        </keep-alive>
      </RouterView>
    </main>
    <AlertPanel />
  </div>
</template>
