export function shortenAddress(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length < head + tail + 2) return addr;
  return `${addr.slice(0, head + 2)}...${addr.slice(-tail)}`;
}

export function bscscanTxUrl(txHash: string): string {
  return `https://bscscan.com/tx/${txHash}`;
}

export function bscscanAddressUrl(addr: string): string {
  return `https://bscscan.com/address/${addr}`;
}

export function maskSecret(value: string, show = 4): string {
  if (!value || value.length <= show * 2) return '****';
  return `${value.slice(0, show)}...${value.slice(-show)}`;
}

export function formatTokenAmount(raw: string, decimals: number): string {
  const n = Number(raw) / 10 ** decimals;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

export function rpcLatencyStatus(ms: number): string {
  if (ms < 300) return 'good';
  if (ms < 800) return 'normal';
  if (ms < 1500) return 'slow_but_usable';
  if (ms < 3000) return 'slow';
  return 'error_or_switch';
}
