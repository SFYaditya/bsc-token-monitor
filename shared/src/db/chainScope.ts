import { CHAIN_ID } from '../config.js';

/** BSC 主网；所有业务 SQL 应带上 chain_id 过滤 */
export { CHAIN_ID };

/** WHERE 子句片段：chain_id = ? AND token_address = ? */
export function tokenWhere(extra = ''): string {
  const base = 'chain_id = ? AND token_address = ?';
  return extra ? `${base} AND ${extra}` : base;
}

export function tokenParams(tokenAddress: string, ...rest: unknown[]): unknown[] {
  return [CHAIN_ID, tokenAddress.toLowerCase(), ...rest];
}
