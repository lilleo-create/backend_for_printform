"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderCompletionService = void 0;
const prisma_1 = require("../lib/prisma");
const payoutService_1 = require("./payoutService");
const terminalOrderStatuses = new Set(['CANCELLED', 'RETURNED', 'EXPIRED']);
const toDb = (tx) => (tx ?? prisma_1.prisma);
exports.orderCompletionService = {
    async completeOrderFromDeliveryReceipt(orderId, source, tx) {
        const db = toDb(tx);
        const order = await db.order.findUnique({ where: { id: orderId } });
        if (!order)
            return { completed: false, reason: 'ORDER_NOT_FOUND' };
        if (!order.paidAt && order.paymentStatus !== 'PAID') {
            return { completed: false, reason: 'ORDER_NOT_PAID' };
        }
        if (terminalOrderStatuses.has(order.status)) {
            return { completed: false, reason: 'ORDER_TERMINAL' };
        }
        if (order.completedAt) {
            return { completed: false, reason: 'ALREADY_COMPLETED' };
        }
        await db.order.update({
            where: { id: orderId },
            data: {
                status: 'DELIVERED',
                statusUpdatedAt: new Date(),
                completedAt: new Date()
            }
        });
        await db.orderDeliveryEvent.create({
            data: {
                orderId,
                provider: 'SYSTEM',
                status: 'ORDER_COMPLETED',
                description: 'Order completed from delivery receipt',
                raw: { source }
            }
        });
        return { completed: true, reason: null };
    },
    async releaseFundsForCompletedOrder(orderId, tx) {
        const db = toDb(tx);
        const order = await db.order.findUnique({ where: { id: orderId } });
        if (!order)
            return { released: false, reason: 'ORDER_NOT_FOUND' };
        if (order.fundsReleasedAt)
            return { released: false, reason: 'ALREADY_RELEASED' };
        const payoutResult = await payoutService_1.payoutService.releaseForDeliveredOrder(orderId, tx);
        if (payoutResult.skipped === 'ALREADY_RELEASED') {
            await db.order.update({ where: { id: orderId }, data: { fundsReleasedAt: new Date() } });
            return { released: false, reason: 'ALREADY_RELEASED' };
        }
        if (payoutResult.skipped)
            return { released: false, reason: payoutResult.skipped };
        await db.order.update({ where: { id: orderId }, data: { fundsReleasedAt: new Date() } });
        return { released: true, reason: null };
    }
};
