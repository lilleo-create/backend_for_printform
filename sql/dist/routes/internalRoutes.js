"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.internalRoutes = void 0;
const express_1 = require("express");
const shipmentsSyncJob_1 = require("../jobs/shipmentsSyncJob");
const cdekWebhookService_1 = require("../services/cdekWebhookService");
exports.internalRoutes = (0, express_1.Router)();
exports.internalRoutes.post('/jobs/shipments-sync', async (_req, res, next) => {
    try {
        const result = await (0, shipmentsSyncJob_1.runShipmentsSyncJob)();
        res.json({ data: result });
    }
    catch (error) {
        next(error);
    }
});
exports.internalRoutes.post('/cdek/webhooks/ensure-order-status', async (_req, res, next) => {
    try {
        const result = await cdekWebhookService_1.cdekWebhookService.ensureCdekOrderStatusWebhook();
        res.json({ data: result });
    }
    catch (error) {
        next(error);
    }
});
exports.internalRoutes.post('/cdek/orders/:id/sync-status', async (req, res, next) => {
    try {
        const result = await cdekWebhookService_1.cdekWebhookService.syncCdekOrderStatus(req.params.id);
        res.json({ data: result });
    }
    catch (error) {
        next(error);
    }
});
exports.internalRoutes.post('/cdek/orders/sync-active', async (req, res, next) => {
    try {
        const rawLimit = Number(req.body?.limit ?? 100);
        const limit = Number.isFinite(rawLimit) ? Math.min(500, Math.max(1, Math.round(rawLimit))) : 100;
        const result = await cdekWebhookService_1.cdekWebhookService.syncCdekStatusesForActiveOrders(limit);
        res.json({ data: result });
    }
    catch (error) {
        next(error);
    }
});
