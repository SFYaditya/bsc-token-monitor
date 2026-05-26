import { createRouter, createWebHistory } from 'vue-router';
import { defaultTokenPath } from './composables/useAppStore';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: () => defaultTokenPath() },
    { path: '/dashboard', redirect: () => defaultTokenPath() },
    { path: '/login', component: () => import('./views/LoginView.vue') },
    {
      path: '/',
      component: () => import('./layouts/AppShell.vue'),
      children: [
        { path: 'tokens', redirect: () => defaultTokenPath() },
        { path: 'tokens/:address', redirect: (to) => `/tokens/${to.params.address}/overview` },
        {
          path: 'tokens/:address/overview',
          component: () => import('./views/token/TokenOverviewTab.vue'),
        },
        {
          path: 'tokens/:address/trades',
          component: () => import('./views/token/TokenTradesTab.vue'),
        },
        {
          path: 'tokens/:address/holders',
          component: () => import('./views/token/TokenHoldersTab.vue'),
        },
        {
          path: 'tokens/:address/whales',
          redirect: (to) => `/tokens/${to.params.address}/holders`,
        },
        {
          path: 'tokens/:address/whale-activity',
          component: () => import('./views/token/TokenWhaleActivityTab.vue'),
        },
        {
          path: 'tokens/:address/staking',
          component: () => import('./views/token/TokenStakingTab.vue'),
        },
        {
          path: 'tokens/:address/liquidity',
          component: () => import('./views/token/TokenLiquidityTab.vue'),
        },
        {
          path: 'tokens/:address/alerts',
          component: () => import('./views/token/TokenAlertsTab.vue'),
        },
        {
          path: 'tokens/:address/address/:wallet',
          component: () => import('./views/AddressDetailView.vue'),
        },
        {
          path: 'tokens/:address/addresses/:wallet',
          redirect: (to) => `/tokens/${to.params.address}/address/${to.params.wallet}`,
        },
        { path: 'settings', component: () => import('./views/SettingsView.vue') },
        { path: 'alerts', redirect: '/settings' },
        { path: 'system', redirect: { path: '/settings', query: { tab: 'system' } } },
      ],
    },
  ],
});

router.beforeEach((to) => {
  const needAuth = to.path !== '/login';
  const token = localStorage.getItem('auth_token');
  const pwdRequired = localStorage.getItem('auth_required') === '1';
  if (needAuth && pwdRequired && !token) return '/login';
  return true;
});

router.afterEach((to) => {
  const base = '链察';
  if (to.path === '/login') {
    document.title = `登录 · ${base}`;
    return;
  }
  if (to.path === '/settings') {
    document.title = `设置 · ${base}`;
    return;
  }
  const tab = to.path.split('/').pop() ?? '';
  const tabZh: Record<string, string> = {
    overview: '总览',
    trades: '买卖',
    holders: '持仓榜',
    'whale-activity': '巨鲸动态',
    whales: '持仓榜',
    staking: '质押',
    liquidity: '流动性',
    alerts: '告警',
    address: '地址',
  };
  const label = tabZh[tab] ?? tab;
  document.title = `${label} · ${base}`;
});

export default router;
