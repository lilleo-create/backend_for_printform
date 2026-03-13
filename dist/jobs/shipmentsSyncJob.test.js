"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const shipmentsSyncJob_1 = require("./shipmentsSyncJob");
(0, node_test_1.default)('mapCdekStatus maps CREATED/ACCEPTED without forcing IN_TRANSIT', () => {
    strict_1.default.equal((0, shipmentsSyncJob_1.mapCdekStatus)('CREATED'), 'READY_FOR_SHIPMENT');
    strict_1.default.equal((0, shipmentsSyncJob_1.mapCdekStatus)('ACCEPTED'), 'HANDED_TO_DELIVERY');
    strict_1.default.equal((0, shipmentsSyncJob_1.mapCdekStatus)('SENT_TO_TRANSIT_CITY'), 'IN_TRANSIT');
    strict_1.default.equal((0, shipmentsSyncJob_1.mapCdekStatus)('DELIVERED'), 'DELIVERED');
    strict_1.default.equal((0, shipmentsSyncJob_1.mapCdekStatus)('NOT_DELIVERED'), 'RETURNED');
    strict_1.default.equal((0, shipmentsSyncJob_1.mapCdekStatus)('REMOVED'), 'CANCELLED');
});
