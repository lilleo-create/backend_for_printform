"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const prisma_1 = require("../lib/prisma");
const cdekService_1 = require("./cdekService");
const shipmentService_1 = require("./shipmentService");
(0, node_test_1.default)('mapExternalStatusToInternal maps CDEK statuses', () => {
    strict_1.default.equal((0, shipmentService_1.mapExternalStatusToInternal)('ACCEPTED'), 'READY_TO_SHIP');
    strict_1.default.equal((0, shipmentService_1.mapExternalStatusToInternal)('IN_TRANSIT'), 'IN_TRANSIT');
    strict_1.default.equal((0, shipmentService_1.mapExternalStatusToInternal)('READY_FOR_PICKUP'), 'IN_TRANSIT');
    strict_1.default.equal((0, shipmentService_1.mapExternalStatusToInternal)('DELIVERED'), 'DELIVERED');
    strict_1.default.equal((0, shipmentService_1.mapExternalStatusToInternal)('INVALID'), 'CANCELLED');
});
(0, node_test_1.default)('normalizePvzProvider upgrades legacy provider to CDEK when pvz code matches', async () => {
    let updated = false;
    prisma_1.prisma.order.update = async ({ data }) => {
        updated = data?.buyerPickupPvzMeta?.provider === 'CDEK';
        return {};
    };
    const order = {
        id: 'o-1',
        carrier: 'CDEK',
        buyerPickupPvzId: 'MSK117',
        buyerPickupPvzMeta: { provider: 'LEGACY' }
    };
    const normalized = await (0, shipmentService_1.normalizePvzProvider)(order);
    strict_1.default.equal(updated, true);
    strict_1.default.equal(normalized.buyerPickupPvzMeta.provider, 'CDEK');
});
(0, node_test_1.default)('syncByOrderId persists trackingNumber even when snapshot value has extra spaces', async () => {
    prisma_1.prisma.order.findUnique = async () => ({
        id: 'order-1',
        cdekOrderId: 'cdek-order-uuid',
        sellerDropoffPvzId: 'MSK1',
        buyerPickupPvzId: 'MSK2',
        shipment: null
    });
    cdekService_1.cdekService.getOrderByUuid = async () => ({
        cdekOrderId: 'cdek-order-uuid',
        status: 'ACCEPTED',
        trackingNumber: ' 1234567890 ',
        requestUuid: 'request-1',
        relatedEntities: { waybillUrl: null, barcodeUrls: [] },
        raw: { related_entities: [] }
    });
    prisma_1.prisma.$transaction = async (cb) => cb({
        orderShipment: {
            upsert: async () => ({ id: 'shipment-1', status: 'READY_TO_SHIP', statusRaw: {} })
        },
        order: {
            update: async ({ data }) => {
                strict_1.default.equal(data.trackingNumber, '1234567890');
                return {};
            }
        },
        orderShipmentStatusHistory: {
            create: async () => ({ id: 'history-1' })
        }
    });
    const result = await shipmentService_1.shipmentService.syncByOrderId('order-1');
    strict_1.default.equal(result.snapshot.trackingNumber, ' 1234567890 ');
});
