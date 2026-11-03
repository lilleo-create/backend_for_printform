import { Router } from 'express';
import { shipmentService } from '../services/shipmentService';
import { requireAuth, requireAdmin, type AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { findAuthorizedTracking } from '../services/trackingAccess';

export const shipmentsRoutes = Router();

shipmentsRoutes.get('/track/:trackingNumber', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const trackingNumber = String(req.params.trackingNumber ?? '').trim();
    if (!trackingNumber) {
      return res.status(400).json({ error: { code: 'TRACKING_NUMBER_REQUIRED' } });
    }

    const shipment = await findAuthorizedTracking(trackingNumber, req.user!);

    if (shipment) {
      return res.json({
        data: {
          trackingNumber: shipment.order.trackingNumber,
          carrier: shipment.order.carrier,
          status: shipment.status,
          updatedAt: shipment.updatedAt
        }
      });
    }

    return res.status(404).json({ error: { code: 'TRACKING_NOT_FOUND' } });
  } catch (error) {
    next(error);
  }
});


shipmentsRoutes.post('/:id/sync', requireAuth, requireAdmin, writeLimiter, async (req, res, next) => {
  try {
    const result = await shipmentService.syncByShipmentId(req.params.id);
    return res.json({
      data: {
        id: result.shipment.id,
        status: result.shipment.status,
        trackingNumber: result.snapshot.trackingNumber,
        cdekStatus: result.snapshot.status,
        statusRaw: result.shipment.statusRaw
      }
    });
  } catch (error) {
    next(error);
  }
});
