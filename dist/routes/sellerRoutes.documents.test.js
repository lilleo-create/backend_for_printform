"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const express_1 = __importDefault(require("express"));
const supertest_1 = __importDefault(require("supertest"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const sellerRoutes_1 = require("./sellerRoutes");
const prisma_1 = require("../lib/prisma");
const env_1 = require("../config/env");
const cdekService_1 = require("../services/cdekService");
const buildApp = () => {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use('/seller', sellerRoutes_1.sellerRoutes);
    return app;
};
const tokenFor = (userId) => jsonwebtoken_1.default.sign({ userId, role: 'SELLER', scope: 'access' }, env_1.env.jwtSecret);
const mockAuth = () => {
    prisma_1.prisma.user.findUnique = async () => ({ role: 'SELLER' });
    prisma_1.prisma.sellerProfile.findUnique = async () => ({ id: 'sp-1' });
    prisma_1.prisma.order.update = async ({ where }) => ({ id: where?.id ?? 'order-own' });
    prisma_1.prisma.orderShipment.update = async ({ where, data }) => ({ id: where?.id ?? 'shipment-1', ...data });
    prisma_1.prisma.payment.findFirst = async () => ({ status: 'SUCCEEDED' });
};
const mockOrder = (orderId) => ({
    id: orderId,
    createdAt: new Date('2026-01-01T10:00:00.000Z'),
    total: 1500,
    currency: 'RUB',
    recipientName: 'Иван Иванов',
    recipientPhone: '+79990000000',
    recipientEmail: 'ivan@test.dev',
    packagesCount: 1,
    orderLabels: [{ packageNo: 1, code: 'PF-ABC-1' }],
    buyerPickupPvzMeta: { addressFull: 'ПВЗ покупателя' },
    sellerDropoffPvzMeta: { addressFull: 'ПВЗ продавца' },
    paidAt: new Date('2026-01-01T09:00:00.000Z'),
    cdekOrderId: 'cdek-uuid',
    shipment: { id: 'shipment-1', labelPrintRequestUuid: 'label-print-uuid', actPrintRequestUuid: 'act-print-uuid' },
    items: [{ quantity: 1, priceAtPurchase: 1500, product: { title: 'Товар' } }]
});
(0, node_test_1.default)('seller documents endpoints return application/pdf and 200 for own order', async () => {
    mockAuth();
    cdekService_1.cdekService.getOrderPrintStatus = async () => ({ status: 'READY' });
    cdekService_1.cdekService.downloadOrderPrintPdf = async () => Buffer.from('%PDF-ready%');
    cdekService_1.cdekService.getBarcodePrintTaskForLabel = async () => ({ status: 'READY', statuses: [] });
    cdekService_1.cdekService.downloadBarcodePdf = async () => Buffer.from('%PDF-ready%');
    prisma_1.prisma.order.findFirst = async ({ where }) => {
        if (where.id === 'order-own')
            return mockOrder('order-own');
        return null;
    };
    const app = buildApp();
    const auth = `Bearer ${tokenFor('seller-1')}`;
    const packing = await (0, supertest_1.default)(app).get('/seller/orders/order-own/documents/packing-slip.pdf').set('Authorization', auth);
    const labels = await (0, supertest_1.default)(app).get('/seller/orders/order-own/documents/label.pdf').set('Authorization', auth);
    const act = await (0, supertest_1.default)(app).get('/seller/orders/order-own/documents/handover-act.pdf').set('Authorization', auth);
    strict_1.default.equal(packing.status, 200);
    strict_1.default.equal(labels.status, 200);
    strict_1.default.equal(act.status, 200);
    strict_1.default.match(packing.headers['content-type'] ?? '', /application\/pdf/);
    strict_1.default.match(labels.headers['content-type'] ?? '', /application\/pdf/);
    strict_1.default.match(act.headers['content-type'] ?? '', /application\/pdf/);
});
(0, node_test_1.default)('seller can access documents only for own orders', async () => {
    mockAuth();
    prisma_1.prisma.order.findFirst = async ({ where }) => {
        if (where.id === 'order-own')
            return mockOrder('order-own');
        return null;
    };
    const app = buildApp();
    const auth = `Bearer ${tokenFor('seller-1')}`;
    const denied = await (0, supertest_1.default)(app)
        .get('/seller/orders/order-other/documents/packing-slip.pdf')
        .set('Authorization', auth);
    strict_1.default.equal(denied.status, 404);
});
(0, node_test_1.default)('seller label/act return NEED_READY_TO_SHIP when CDEK shipment is missing', async () => {
    mockAuth();
    prisma_1.prisma.order.findFirst = async ({ where }) => {
        if (where.id === 'order-own') {
            return { ...mockOrder('order-own'), cdekOrderId: null, shipment: null };
        }
        return null;
    };
    const app = buildApp();
    const auth = `Bearer ${tokenFor('seller-1')}`;
    const label = await (0, supertest_1.default)(app).get('/seller/orders/order-own/documents/label.pdf').set('Authorization', auth);
    const act = await (0, supertest_1.default)(app).get('/seller/orders/order-own/documents/handover-act.pdf').set('Authorization', auth);
    strict_1.default.equal(label.status, 409);
    strict_1.default.equal(act.status, 409);
    strict_1.default.equal(label.body?.error?.code, 'NEED_READY_TO_SHIP');
    strict_1.default.equal(act.body?.error?.code, 'NEED_READY_TO_SHIP');
});
(0, node_test_1.default)('handover act is downloaded from CDEK order print API', async () => {
    mockAuth();
    cdekService_1.cdekService.getOrderPrintStatus = async () => ({ status: 'READY' });
    cdekService_1.cdekService.downloadOrderPrintPdf = async () => Buffer.from('%PDF-1.4 mock-from-cdek%');
    prisma_1.prisma.order.findFirst = async ({ where }) => {
        if (where.id === 'order-own')
            return mockOrder('order-own');
        return null;
    };
    const app = buildApp();
    const auth = `Bearer ${tokenFor('seller-1')}`;
    const act = await (0, supertest_1.default)(app).get('/seller/orders/order-own/documents/handover-act.pdf').set('Authorization', auth);
    strict_1.default.equal(act.status, 200);
    strict_1.default.match(act.headers['content-type'] ?? '', /application\/pdf/);
    strict_1.default.equal(Number(act.headers['content-length']), Buffer.from('%PDF-1.4 mock-from-cdek%').length);
});
(0, node_test_1.default)('seller label route uses CDEK order print API when print task is ready', async () => {
    mockAuth();
    cdekService_1.cdekService.getBarcodePrintTaskForLabel = async () => ({ status: 'READY', statuses: [] });
    cdekService_1.cdekService.downloadBarcodePdf = async () => Buffer.from('%PDF-fallback-label%');
    prisma_1.prisma.order.findFirst = async ({ where }) => {
        if (where.id === 'order-own')
            return mockOrder('order-own');
        return null;
    };
    const app = buildApp();
    const auth = `Bearer ${tokenFor('seller-1')}`;
    const label = await (0, supertest_1.default)(app).get('/seller/orders/order-own/documents/label.pdf').set('Authorization', auth);
    strict_1.default.equal(label.status, 200);
    strict_1.default.match(label.headers['content-type'] ?? '', /application\/pdf/);
});
(0, node_test_1.default)('seller label route returns FORMS_NOT_READY when print task is processing', async () => {
    mockAuth();
    cdekService_1.cdekService.getBarcodePrintTaskForLabel = async () => ({ status: 'PROCESSING', statuses: [] });
    prisma_1.prisma.order.findFirst = async ({ where }) => {
        if (where.id === 'order-own')
            return mockOrder('order-own');
        return null;
    };
    const app = buildApp();
    const auth = `Bearer ${tokenFor('seller-1')}`;
    const label = await (0, supertest_1.default)(app).get('/seller/orders/order-own/documents/label.pdf').set('Authorization', auth);
    strict_1.default.equal(label.status, 409);
    strict_1.default.equal(label.body?.error?.code, 'FORMS_NOT_READY');
});
