import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { cdekService } from '../services/cdekService';
import { shipmentService } from '../services/shipmentService';

export const shipmentsRoutes = Router();

shipmentsRoutes.get('/track/:trackingNumber', async (req, res, next) => {
  try {
    const trackingNumber = String(req.params.trackingNumber ?? '').trim();
    if (!trackingNumber) {
      return res.status(400).json({ error: { code: 'TRACKING_NUMBER_REQUIRED' } });
    }

    const shipment = await prisma.orderShipment.findFirst({
      where: { order: { trackingNumber } },
      include: { order: true }
    });

    if (shipment) {
      return res.json({
        data: {
          id: shipment.id,
          orderId: shipment.orderId,
          trackingNumber: shipment.order.trackingNumber,
          carrier: shipment.order.carrier,
          status: shipment.status,
          pvz: shipment.destinationStationId,
          dropoffPvz: shipment.sourceStationId,
          updatedAt: shipment.updatedAt
        }
      });
    }

    const cdekInfo = await cdekService.getOrderByTracking(trackingNumber);

    return res.json({
      data: {
        trackingNumber: cdekInfo.trackingNumber,
        carrier: 'CDEK',
        status: cdekInfo.status,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
});


shipmentsRoutes.post('/:id/sync', async (req, res, next) => {
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
