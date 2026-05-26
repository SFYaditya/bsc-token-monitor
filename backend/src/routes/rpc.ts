import { Router } from 'express';
import {
  getRpcManagerStatus,
  runRpcHealthCheckAll,
  switchRpcByIndex,
} from '@token-monitor/shared';
import { ok, fail } from '../util/response.js';
import { broadcastRealtime } from '../realtime/hub.js';
import { requireAuth } from '../middleware/auth.js';

export function createRpcRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get('/status', async (_req, res) => {
    try {
      const status = await getRpcManagerStatus();
      ok(res, status);
    } catch (e) {
      fail(res, e instanceof Error ? e.message : 'RPC status failed', 500);
    }
  });

  r.post('/health-check', async (_req, res) => {
    try {
      const status = await runRpcHealthCheckAll();
      broadcastRealtime({
        type: 'rpc_status_update',
        data: { ...status, reason: 'manual_health_check' },
      });
      ok(res, status);
    } catch (e) {
      fail(res, e instanceof Error ? e.message : 'health check failed', 500);
    }
  });

  r.post('/switch', async (req, res) => {
    const index = Number(req.body?.index);
    if (!Number.isFinite(index)) {
      return fail(res, '请提供 index（数字）', 400);
    }
    const allowHighLatency = req.body?.allowHighLatency === true;
    try {
      const result = await switchRpcByIndex(index, { allowHighLatency });
      broadcastRealtime({
        type: 'rpc_status_update',
        data: { ...result.status, reason: 'manual_switch' },
      });
      ok(res, result);
    } catch (e) {
      fail(res, e instanceof Error ? e.message : 'switch failed', 400);
    }
  });

  return r;
}
