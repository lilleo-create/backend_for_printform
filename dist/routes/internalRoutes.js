"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.internalRoutes = void 0;
const express_1 = require("express");
const shipmentsSyncJob_1 = require("../jobs/shipmentsSyncJob");
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
