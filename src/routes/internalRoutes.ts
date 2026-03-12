import { Router } from 'express';
import { runShipmentsSyncJob } from '../jobs/shipmentsSyncJob';

export const internalRoutes = Router();

internalRoutes.post('/jobs/shipments-sync', async (_req, res, next) => {
  try {
    const result = await runShipmentsSyncJob();
    res.json({ data: result });
  } catch (error) {
    next(error);
  }
});
