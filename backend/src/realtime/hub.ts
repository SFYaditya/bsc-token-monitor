import type { Server } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';

interface WsClient {
  ws: WebSocket;
  channels: Set<string>;
}

let wss: WebSocketServer | null = null;
const clients = new Set<WsClient>();

export function attachRealtimeServer(server: Server): void {
  if (wss) return;
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    const client: WsClient = { ws, channels: new Set(['alerts']) };
    clients.add(client);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as {
          action?: string;
          channels?: string[];
        };
        if (msg.action === 'subscribe' && Array.isArray(msg.channels)) {
          client.channels = new Set(msg.channels.map((c) => c.toLowerCase()));
        }
      } catch {
        /* ignore */
      }
    });

    ws.on('close', () => clients.delete(client));
    ws.send(JSON.stringify({ type: 'connected', data: { ok: true } }));
  });

  console.log('[WS] realtime server on /ws');
}

export function broadcastRealtime(input: {
  type: string;
  tokenAddress?: string;
  data: Record<string, unknown>;
}): number {
  const token = input.tokenAddress?.toLowerCase() ?? '';
  const payload = JSON.stringify({
    type: input.type,
    tokenAddress: token || undefined,
    data: input.data,
    ts: Date.now(),
  });
  const channels = new Set([
    ...(token ? [`token:${token}`] : []),
    input.type === 'alert_event' ? 'alerts' : '',
    input.type === 'new_trade' ? 'trades' : '',
    input.type === 'holder_update' ? 'holders' : '',
    input.type === 'price_update' && token ? `token:${token}` : '',
    input.type === 'rpc_status_update' ? 'rpc' : '',
    input.type === 'rpc_status_update' ? 'system' : '',
  ]);

  let sent = 0;
  for (const client of clients) {
    const hit = [...channels].some((ch) => ch && client.channels.has(ch));
    if (!hit) continue;
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(payload);
      sent++;
    }
  }
  return sent;
}
