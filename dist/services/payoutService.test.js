"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = __importDefault(require("node:test"));
const strict_1 = __importDefault(require("node:assert/strict"));
const prisma_1 = require("../lib/prisma");
const payoutService_1 = require("./payoutService");
(0, node_test_1.default)('delivered creates payout once and second call is no-op', async () => {
    let created = 0;
    let payoutLookupCount = 0;
    prisma_1.prisma.order.findUnique = async () => ({
        id: 'order-1',
        status: 'DELIVERED',
        payoutStatus: payoutLookupCount === 0 ? 'HOLD' : 'RELEASED',
        total: 100,
        currency: 'RUB'
    });
    prisma_1.prisma.orderItem.findFirst = async () => ({ product: { sellerId: 'seller-1' } });
    prisma_1.prisma.payout.findUnique = async () => {
        payoutLookupCount += 1;
        return payoutLookupCount > 1 ? { id: 'po-1' } : null;
    };
    prisma_1.prisma.payout.create = async () => {
        created += 1;
        return {};
    };
    prisma_1.prisma.order.update = async () => ({});
    await payoutService_1.payoutService.releaseForDeliveredOrder('order-1');
    await payoutService_1.payoutService.releaseForDeliveredOrder('order-1');
    strict_1.default.equal(created, 1);
});
(0, node_test_1.default)('cancelled order sets BLOCKED and does not create payout', async () => {
    let created = 0;
    let blocked = false;
    prisma_1.prisma.order.findUnique = async () => ({
        id: 'order-2',
        status: 'RETURNED',
        payoutStatus: 'HOLD',
        total: 200,
        currency: 'RUB'
    });
    prisma_1.prisma.payout.findUnique = async () => null;
    prisma_1.prisma.payout.create = async () => {
        created += 1;
        return {};
    };
    prisma_1.prisma.order.update = async ({ data }) => {
        if (data.payoutStatus === 'BLOCKED')
            blocked = true;
        return {};
    };
    await payoutService_1.payoutService.releaseForDeliveredOrder('order-2');
    strict_1.default.equal(created, 0);
    strict_1.default.equal(blocked, true);
});
