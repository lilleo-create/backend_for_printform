"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const client_1 = require("@prisma/client");
const paymentFlowService_1 = require("./paymentFlowService");
const prisma_1 = require("../lib/prisma");
const orderUseCases_1 = require("../usecases/orderUseCases");
const inputBase = {
    buyerId: 'buyer-1',
    recipient: { name: 'Иван Иванов', phone: '+79990000000', email: 'ivan@test.dev' },
    buyerPickupPvz: { provider: 'CDEK', pvzId: 'pvz-1' },
    items: [{ productId: 'product-1', quantity: 1 }]
};
(0, node_test_1.default)('startPayment double-click with same paymentAttemptKey -> 1 order, 1 payment', async () => {
    let orderCreateCalls = 0;
    let paymentCreateCalls = 0;
    prisma_1.prisma.order.findFirst = async ({ where }) => {
        if (where.paymentAttemptKey === 'attempt-1' && orderCreateCalls > 0) {
            return {
                id: 'order-1',
                total: 100,
                currency: 'RUB',
                packagesCount: 1,
                orderLabels: [{ packageNo: 1, code: 'PF-1' }],
                recipientName: 'Иван Иванов',
                recipientPhone: '+79990000000'
            };
        }
        return null;
    };
    prisma_1.prisma.product.findMany = async () => ([{ id: 'product-1', sellerId: 'seller-1' }]);
    prisma_1.prisma.sellerSettings.findUnique = async () => ({ defaultDropoffPvzId: 'dropoff-1', defaultDropoffPvzMeta: {} });
    prisma_1.prisma.sellerDeliveryProfile.findUnique = async () => ({ dropoffStationId: '10022023854' });
    orderUseCases_1.orderUseCases.create = async () => {
        orderCreateCalls += 1;
        if (orderCreateCalls === 1) {
            return { id: 'order-1', total: 100, currency: 'RUB', packagesCount: 1, orderLabels: [] };
        }
        throw new client_1.Prisma.PrismaClientKnownRequestError('Unique', {
            code: 'P2002',
            clientVersion: '5.18.0',
            meta: { target: ['buyerId', 'paymentAttemptKey'] }
        });
    };
    prisma_1.prisma.order.update = async ({ data }) => ({ id: 'order-1', total: 100, currency: 'RUB', packagesCount: 1, ...data });
    let paymentFindCalls = 0;
    prisma_1.prisma.payment.findFirst = async () => {
        paymentFindCalls += 1;
        if (paymentFindCalls > 1)
            return { id: 'pay-1', payloadJson: { paymentUrl: 'https://payment.local/checkout/pay-1' } };
        return null;
    };
    prisma_1.prisma.$transaction = async (cb) => cb({
        order: {
            findUnique: async () => ({ id: 'order-1', total: 100, currency: 'RUB', paymentId: null }),
            updateMany: async () => ({ count: 1 }),
            findUniqueOrThrow: async () => ({})
        },
        payment: {
            findUnique: async () => null,
            create: async () => {
                paymentCreateCalls += 1;
                return { id: 'pay-1', provider: 'manual' };
            },
            update: async () => ({}),
            delete: async () => ({})
        }
    });
    const first = await paymentFlowService_1.paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-1' });
    const second = await paymentFlowService_1.paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-1' });
    strict_1.default.equal(first.orderId, second.orderId);
    strict_1.default.equal(paymentCreateCalls, 1);
});
(0, node_test_1.default)('startPayment with different paymentAttemptKey creates new order', async () => {
    let createdOrders = 0;
    prisma_1.prisma.order.findFirst = async () => null;
    prisma_1.prisma.product.findMany = async () => ([{ id: 'product-1', sellerId: 'seller-1' }]);
    prisma_1.prisma.sellerSettings.findUnique = async () => ({ defaultDropoffPvzId: 'dropoff-1', defaultDropoffPvzMeta: {} });
    prisma_1.prisma.sellerDeliveryProfile.findUnique = async () => ({ dropoffStationId: '10022023854' });
    orderUseCases_1.orderUseCases.create = async ({ paymentAttemptKey }) => {
        createdOrders += 1;
        return { id: `order-${paymentAttemptKey}`, total: 100, currency: 'RUB', packagesCount: 1, orderLabels: [] };
    };
    prisma_1.prisma.order.update = async ({ where, data }) => ({ id: where.id, total: 100, currency: 'RUB', packagesCount: 1, ...data });
    prisma_1.prisma.payment.findFirst = async () => null;
    prisma_1.prisma.$transaction = async (cb) => cb({
        order: {
            findUnique: async ({ where }) => ({ id: where.id, total: 100, currency: 'RUB', paymentId: null }),
            updateMany: async () => ({ count: 1 })
        },
        payment: {
            findUnique: async () => null,
            create: async ({ data }) => ({ id: `pay-${data.orderId}`, provider: 'manual' }),
            update: async () => ({}),
            delete: async () => ({})
        }
    });
    const first = await paymentFlowService_1.paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-A' });
    const second = await paymentFlowService_1.paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-B' });
    strict_1.default.notEqual(first.orderId, second.orderId);
    strict_1.default.equal(createdOrders, 2);
});
(0, node_test_1.default)('webhook success makes order PAID and sets paidAt', async () => {
    prisma_1.prisma.payment.findUnique = async () => ({ id: 'pay-1', provider: 'manual', orderId: 'order-1', order: { id: 'order-1' } });
    let updatedOrderData = null;
    prisma_1.prisma.$transaction = async (cb) => cb({
        order: {
            findUnique: async () => ({ id: 'order-1', status: 'CREATED' }),
            update: async ({ data }) => {
                updatedOrderData = data;
                return {};
            },
            updateMany: async () => ({ count: 0 })
        },
        payment: { update: async () => ({}) }
    });
    await paymentFlowService_1.paymentFlowService.processWebhook({ paymentId: 'pay-1', status: 'success' });
    strict_1.default.equal(updatedOrderData.status, 'PAID');
    strict_1.default.ok(updatedOrderData.paidAt instanceof Date);
});
(0, node_test_1.default)('startPayment allows checkout when seller dropoff config is missing without blocking flags', async () => {
    prisma_1.prisma.order.findFirst = async () => null;
    prisma_1.prisma.product.findMany = async () => ([{ id: 'product-1', sellerId: 'seller-1' }]);
    prisma_1.prisma.sellerSettings.findUnique = async () => ({ defaultDropoffPvzId: null, defaultDropoffPvzMeta: null });
    let createdPayload = null;
    orderUseCases_1.orderUseCases.create = async (payload) => {
        createdPayload = payload;
        return {
            id: 'order-missing-dropoff',
            total: 100,
            currency: 'RUB',
            packagesCount: 1,
            orderLabels: [],
            sellerDropoffPvzId: null,
            recipientName: payload.recipient.name,
            recipientPhone: payload.recipient.phone
        };
    };
    prisma_1.prisma.order.update = async ({ where, data }) => ({
        id: where.id,
        total: 100,
        currency: 'RUB',
        packagesCount: 1,
        sellerDropoffPvzId: null,
        ...data
    });
    prisma_1.prisma.payment.findFirst = async () => null;
    prisma_1.prisma.$transaction = async (cb) => cb({
        order: {
            findUnique: async ({ where }) => ({ id: where.id, total: 100, currency: 'RUB', paymentId: null }),
            updateMany: async () => ({ count: 1 })
        },
        payment: {
            findUnique: async () => null,
            create: async ({ data }) => ({ id: `pay-${data.orderId}`, provider: 'manual' }),
            update: async () => ({}),
            delete: async () => ({})
        }
    });
    const result = await paymentFlowService_1.paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-missing-dropoff' });
    strict_1.default.equal(createdPayload.sellerDropoffPvz, undefined);
    strict_1.default.equal(result.deliveryConfigMissing, false);
    strict_1.default.equal(result.blockingReason, null);
});
(0, node_test_1.default)('startPayment rejects multi-seller checkout items', async () => {
    prisma_1.prisma.order.findFirst = async () => null;
    prisma_1.prisma.product.findMany = async () => ([
        { id: 'product-1', sellerId: 'seller-1' },
        { id: 'product-2', sellerId: 'seller-2' }
    ]);
    await strict_1.default.rejects(() => paymentFlowService_1.paymentFlowService.startPayment({
        ...inputBase,
        paymentAttemptKey: 'attempt-multi-seller',
        items: [
            { productId: 'product-1', quantity: 1 },
            { productId: 'product-2', quantity: 2 }
        ]
    }), /MULTI_SELLER_CHECKOUT_NOT_SUPPORTED/);
});
