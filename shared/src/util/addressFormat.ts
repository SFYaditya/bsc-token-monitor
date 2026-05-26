/** TG / 面板短地址：前 4 位 + … + 后 6 位（含 0x 前缀） */
export function formatShortAddress(address: string): string {
  const a = String(address ?? '').trim();
  if (!a || a.length < 12) return a;
  return `${a.slice(0, 4)}...${a.slice(-6)}`;
}
