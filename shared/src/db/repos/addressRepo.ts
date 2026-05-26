import { dbGet, dbRun } from '../pg/query.js';
import { CHAIN_ID } from '../../config.js';

export type AddressType = 'wallet' | 'contract';

export interface AddressRow {
  chain_id: number;
  address: string;
  address_type: AddressType;
  is_contract: number;
  first_seen_at: number;
  updated_at: number;
}

export async function getAddressRecord(address: string): Promise<AddressRow | null> {
  const row = (await dbGet(
    `SELECT * FROM addresses WHERE chain_id = ? AND address = ?`,
    [CHAIN_ID, address.toLowerCase()],
  )) as AddressRow | undefined;
  return row ?? null;
}

export async function upsertAddress(input: {
  address: string;
  address_type: AddressType;
  is_contract: number;
}): Promise<void> {
  const now = Date.now();
  const addr = input.address.toLowerCase();
  await dbRun(
    `INSERT INTO addresses (chain_id, address, address_type, is_contract, first_seen_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (chain_id, address) DO UPDATE SET
       address_type = EXCLUDED.address_type,
       is_contract = EXCLUDED.is_contract,
       updated_at = EXCLUDED.updated_at`,
    [CHAIN_ID, addr, input.address_type, input.is_contract, now, now],
  );
}
