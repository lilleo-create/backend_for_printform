"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const express_1 = __importDefault(require("express"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const paymentRoutes_1 = require("./paymentRoutes");
const errorHandler_1 = require("../middleware/errorHandler");
const prisma_1 = require("../lib/prisma");
const env_1 = require("../config/env");
const tokenFor = (userId) => jsonwebtoken_1.default.sign({ userId, role: 'BUYER', scope: 'access' }, env_1.env.jwtSecret);
const buildApp = () => {
    const app = (0, express_1.default)();
    app.use(express_1.default.json());
    app.use('/payments', paymentRoutes_1.paymentRoutes);
    app.use(errorHandler_1.errorHandler);
    return app;
};
const sendMockSuccess = async (opts) => {
    const app = buildApp();
    const server = app.listen(0);
    try {
        const { port } = server.address();
        const headers = {};
        if (opts.token) {
            headers.Authorization = `Bearer ${opts.token}`;
        }
        const response = await fetch(`http://127.0.0.1:${port}/payments/${opts.paymentId}/mock-success`, {
            method: 'POST',
            headers
        });
        return response;
    }
    finally {
        await new Promise((resolve) => server.close(() => resolve()));
    }
};
(0, node_test_1.default)('mock-success: buyer can pay own payment and order becomes PAID', async () => {
    process.env.NODE_ENV = 'development';
    let orderUpdateData = null;
    let paymentLookups = 0;
    prisma_1.prisma.user.findUnique = async () => ({ role: 'BUYER' });
    prisma_1.prisma.payment.findUnique = async () => {
        paymentLookups += 1;
        if (paymentLookups === 1) {
            return { id: 'pay-own', provider: 'manual', orderId: 'order-own', order: { buyerId: 'buyer-own' } };
        }
        return { id: 'pay-own', provider: 'manual', orderId: 'order-own', order: { id: 'order-own' } };
    };
    prisma_1.prisma.$transaction = async (cb) => cb({
        order: {
            findUnique: async () => ({ id: 'order-own', status: 'CREATED' }),
            update: async ({ data }) => {
                orderUpdateData = data;
                return {};
            },
            updateMany: async () => ({ count: 0 })
        },
        payment: {
            update: async () => ({})
        }
    });
    const response = await sendMockSuccess({ paymentId: 'pay-own', token: tokenFor('buyer-own') });
    strict_1.default.equal(response.status, 200);
    strict_1.default.equal(orderUpdateData.status, 'PAID');
    strict_1.default.ok(orderUpdateData.paidAt instanceof Date);
});
(0, node_test_1.default)('mock-success: unauthorized request returns 401', async () => {
    process.env.NODE_ENV = 'development';
    const response = await sendMockSuccess({ paymentId: 'pay-own' });
    strict_1.default.equal(response.status, 401);
});
(0, node_test_1.default)('mock-success: authorized buyer cannot mock чужой payment', async () => {
    process.env.NODE_ENV = 'development';
    prisma_1.prisma.user.findUnique = async () => ({ role: 'BUYER' });
    prisma_1.prisma.payment.findUnique = async () => ({
        id: 'pay-other',
        provider: 'manual',
        orderId: 'order-other',
        order: { buyerId: 'buyer-owner' }
    });
    const response = await sendMockSuccess({ paymentId: 'pay-other', token: tokenFor('buyer-stranger') });
    strict_1.default.equal(response.status, 403);
});
(0, node_test_1.default)('mock-success: production blocks endpoint', async () => {
    process.env.NODE_ENV = 'production';
    prisma_1.prisma.user.findUnique = async () => ({ role: 'BUYER' });
    const response = await sendMockSuccess({ paymentId: 'pay-own', token: tokenFor('buyer-own') });
    strict_1.default.equal(response.status, 403);
});
