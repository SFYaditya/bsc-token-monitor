import type { Provider } from 'ethers';
import { MONITOR_WALLET } from '../config.js';
import { fetchTokenMeta } from '../token/erc20.js';
import { insertDeployedContract } from '../db/repos/contractRepo.js';
import { setMeta } from '../db/index.js';

export async function scanBlocksForDeploys(
  provider: Provider,
  fromBlock: number,
  toBlock: number,
): Promise<{ deployed: number }> {
  let deployed = 0;
  for (let b = fromBlock; b <= toBlock; b++) {
    const block = await provider.getBlock(b, true);
    if (!block?.prefetchedTransactions) continue;
    for (const tx of block.prefetchedTransactions) {
      if (tx.to != null) continue;
      if (tx.from?.toLowerCase() !== MONITOR_WALLET) continue;
      const receipt = await provider.getTransactionReceipt(tx.hash);
      if (!receipt?.contractAddress) continue;

      const meta = await fetchTokenMeta(provider, receipt.contractAddress);
      const deployTime = (block.timestamp ?? 0) * 1000;
      const ok = await insertDeployedContract({
        deployer_address: MONITOR_WALLET,
        contract_address: receipt.contractAddress,
        tx_hash: tx.hash,
        block_number: b,
        deploy_time: deployTime,
        is_token: !!meta,
        token_name: meta?.name,
        token_symbol: meta?.symbol,
        token_decimals: meta?.decimals,
        total_supply: meta?.totalSupply,
        status: 'deployed_no_liquidity',
      });
      if (ok) deployed += 1;
    }
    if (b % 200 === 0) await setMeta('last_scanned_block', String(b));
  }
  await setMeta('last_scanned_block', String(toBlock));
  return { deployed };
}
