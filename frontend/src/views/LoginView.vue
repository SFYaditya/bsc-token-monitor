<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { apiRaw } from '../api/client';
import { UI, zhApiError } from '../utils/locale';

const router = useRouter();
const password = ref('');
const error = ref('');

async function submit() {
  error.value = '';
  try {
    const res = await apiRaw('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ password: password.value }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error);
    localStorage.setItem('auth_token', json.data.token);
    await router.push('/');
  } catch (e) {
    error.value = zhApiError(e instanceof Error ? e.message : '登录失败');
  }
}

apiRaw('/api/v1/auth/status')
  .then((r) => r.json())
  .then((j) => {
    localStorage.setItem('auth_required', j.data?.required ? '1' : '0');
    if (!j.data?.required) router.replace('/');
  })
  .catch(() => undefined);
</script>

<template>
  <div class="login-wrap">
    <div class="login-card glass">
      <div class="mb-6 flex items-center gap-2">
        <span class="brand-dot" />
        <span class="text-lg font-bold">{{ UI.brand }}</span>
      </div>
      <p class="text-muted mb-6 text-sm">{{ UI.brandSub }}</p>
      <label class="metric-label mb-2 block">访问密码</label>
      <input
        v-model="password"
        type="password"
        class="input mb-4"
        :placeholder="UI.enterPassword"
        @keyup.enter="submit"
      />
      <p v-if="error" class="down mb-3 text-sm">{{ error }}</p>
      <button class="btn btn-primary w-full" @click="submit">进入终端</button>
    </div>
  </div>
</template>
