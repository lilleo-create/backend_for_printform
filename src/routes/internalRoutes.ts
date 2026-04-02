import { Router } from 'express';
import { runShipmentsSyncJob } from '../jobs/shipmentsSyncJob';
import { cdekWebhookService } from '../services/cdekWebhookService';

export const internalRoutes = Router();

internalRoutes.post('/jobs/shipments-sync', async (_req, res, next) => {
  try {
    const result = await runShipmentsSyncJob();
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

internalRoutes.post('/cdek/webhooks/ensure-order-status', async (_req, res, next) => {
  try {
    const result = await cdekWebhookService.ensureCdekOrderStatusWebhook();
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

internalRoutes.post('/cdek/orders/:id/sync-status', async (req, res, next) => {
  try {
    const result = await cdekWebhookService.syncCdekOrderStatus(req.params.id);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});

internalRoutes.post('/cdek/orders/sync-active', async (req, res, next) => {
  try {
    const rawLimit = Number(req.body?.limit ?? 100);
    const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.round(rawLimit))) : 100;
    const result = await cdekWebhookService.syncCdekStatusesForActiveOrders(limit);
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});
