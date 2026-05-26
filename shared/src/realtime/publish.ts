/** Worker → API 实时广播（Docker 内网 POST） */

export interface RealtimeMessage {
  type: string;
  /** 代币级事件必填；dashboard_update 等全局事件可省略 */
  tokenAddress?: string;
  data: Record<string, unknown>;
}

export async function publishRealtime(msg: RealtimeMessage): Promise<void> {
  const base = process.env.REALTIME_BROADCAST_URL?.trim();
  if (!base) return;
  try {
    await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg),
    });
  } catch {
    /* 广播失败不影响主流程 */
  }
}
