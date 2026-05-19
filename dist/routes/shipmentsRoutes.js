"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shipmentsRoutes = void 0;
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const cdekService_1 = require("../services/cdekService");
const shipmentService_1 = require("../services/shipmentService");
exports.shipmentsRoutes = (0, express_1.Router)();
exports.shipmentsRoutes.get('/track/:trackingNumber', async (req, res, next) => {
    try {
        const trackingNumber = String(req.params.trackingNumber ?? '').trim();
        if (!trackingNumber) {
            return res.status(400).json({ error: { code: 'TRACKING_NUMBER_REQUIRED' } });
        }
        const shipment = await prisma_1.prisma.orderShipment.findFirst({
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
        const cdekInfo = await cdekService_1.cdekService.getOrderByTracking(trackingNumber);
        return res.json({
            data: {
                trackingNumber: cdekInfo.trackingNumber,
                carrier: 'CDEK',
                status: cdekInfo.status,
                updatedAt: new Date().toISOString()
            }
        });
    }
    catch (error) {
        next(error);
    }
});
exports.shipmentsRoutes.post('/:id/sync', async (req, res, next) => {
    try {
        const result = await shipmentService_1.shipmentService.syncByShipmentId(req.params.id);
        return res.json({
            data: {
                id: result.shipment.id,
                status: result.shipment.status,
                trackingNumber: result.snapshot.trackingNumber,
                cdekStatus: result.snapshot.status,
                statusRaw: result.shipment.statusRaw
            }
        });
    }
    catch (error) {
        next(error);
    }
});
