import type { Provider } from 'ethers';
import { loadMonitorTokens } from '../monitorTokens.js';
import { getTokenMarket } from '../db/repos/marketRepo.js';
import { refreshLiquidityMonitor } from './liquidityMonitor.js';
import { classifyTokenAddresses } from './addressClassifier.js';
import { computeOpportunityScore } from './opportunityScore.js';
import { scanTokenRisk } from './contractRisk.js';

export async function runPhase2Maintenance(provider: Provider): Promise<void> {
  for (const cfg of loadMonitorTokens()) {
    const token = cfg.tokenAddress;
    try {
      await refreshLiquidityMonitor(provider, token);
      const market = await getTokenMarket(token);
      classifyTokenAddresses(token, market?.priceUsd ?? 0);
      computeOpportunityScore(token);
      await scanTokenRisk(provider, token);
    } catch (err) {
      console.error(
        `[Phase2] ${cfg.symbol}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
