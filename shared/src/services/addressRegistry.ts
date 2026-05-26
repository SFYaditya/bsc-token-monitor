import type { Provider } from 'ethers';
import {
  getAddressRecord,
  upsertAddress,
  type AddressType,
} from '../db/repos/addressRepo.js';

export interface ResolvedAddressType {
  address_type: AddressType;
  is_contract: number;
}

export async function resolveAddressType(
  provider: Provider,
  address: string,
): Promise<ResolvedAddressType> {
  const addr = address.toLowerCase();
  const cached = await getAddressRecord(addr);
  if (cached) {
    return {
      address_type: cached.address_type,
      is_contract: cached.is_contract,
    };
  }
  let isContract = false;
  try {
    const code = await provider.getCode(addr);
    isContract = code !== '0x' && code.length > 2;
  } catch {
    isContract = false;
  }
  const address_type: AddressType = isContract ? 'contract' : 'wallet';
  await upsertAddress({
    address: addr,
    address_type,
    is_contract: isContract ? 1 : 0,
  });
  return { address_type, is_contract: isContract ? 1 : 0 };
}

export async function getCachedAddressType(address: string): Promise<ResolvedAddressType> {
  const cached = await getAddressRecord(address);
  if (cached) {
    return {
      address_type: cached.address_type,
      is_contract: cached.is_contract,
    };
  }
  return { address_type: 'wallet', is_contract: 0 };
}
