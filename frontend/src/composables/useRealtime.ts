import { onMounted, onUnmounted, ref } from 'vue';

export type RealtimePayload = {
  type: string;
  tokenAddress?: string;
  data?: Record<string, unknown>;
  ts?: number;
};

const listeners = new Set<(msg: RealtimePayload) => void>();
let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
const subscribed = ref<string[]>(['alerts', 'rpc', 'system', 'trades', 'holders']);

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function sendSubscribe() {
  if (ws?.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      action: 'subscribe',
      channels: subscribed.value,
    }),
  );
}

function connect() {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;
  ws = new WebSocket(wsUrl());

  ws.onopen = () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    sendSubscribe();
  };

  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as RealtimePayload;
      if (msg.type === 'connected') return;
      for (const fn of listeners) fn(msg);
    } catch {
      /* ignore */
    }
  };

  ws.onclose = () => {
    ws = null;
    reconnectTimer = setTimeout(connect, 3000);
  };
}

export function useRealtime(onMessage: (msg: RealtimePayload) => void) {
  onMounted(() => {
    listeners.add(onMessage);
    connect();
  });
  onUnmounted(() => {
    listeners.delete(onMessage);
  });
}

export function setRealtimeChannels(channels: string[]) {
  subscribed.value = [...new Set(channels.map((c) => c.toLowerCase()))];
  sendSubscribe();
}
