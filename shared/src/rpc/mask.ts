/** 日志 / API / 前端展示用，不暴露 API Key */
export function maskRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    const host = u.host;
    const path = u.pathname && u.pathname !== '/' ? u.pathname : '';
    if (u.username || u.password) {
      return `${u.protocol}//***@${host}${path}`;
    }
    const key = u.searchParams.get('apikey') ?? u.searchParams.get('api_key');
    if (key) {
      u.searchParams.set('apikey', maskSecret(key));
      if (u.searchParams.has('api_key')) u.searchParams.set('api_key', maskSecret(key));
      return `${u.protocol}//${host}${path}?${u.searchParams.toString()}`;
    }
    return `${u.protocol}//${host}${path}${u.search}`;
  } catch {
    return maskSecret(url, 6);
  }
}

export function maskSecret(value: string, show = 4): string {
  if (!value || value.length <= show * 2) return '****';
  return `${value.slice(0, show)}…${value.slice(-show)}`;
}

export function rpcNodeName(index: number, url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return `RPC-${index + 1} (${host})`;
  } catch {
    return `RPC-${index + 1}`;
  }
}

export function sanitizeRpcErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/https?:\/\/[^\s'"<>]+/gi, '[rpc-url]')
    .replace(/api[_-]?key[=:]\s*[^\s&'"]+/gi, 'apikey=***')
    .slice(0, 280);
}

/** 仅明确 429 / rate limit 文案；ethers 的 exceeded maximum retry 多为超时重试，不算限流 */
export function isRateLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code).toLowerCase()
      : '';
  if (code === '429' || msg.includes('status code 429') || msg.includes('http 429')) {
    return true;
  }
  return (
    msg.includes('rate limit') ||
    msg.includes('too many request') ||
    msg.includes('too many requests') ||
    msg.includes('request limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('limit exceeded') ||
    msg.includes('-32005')
  );
}
