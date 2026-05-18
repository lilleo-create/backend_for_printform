"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.expirePendingPayments = exports.canRetryPayment = exports.computePaymentTiming = exports.nextPaymentExpiryDate = exports.PAYMENT_WINDOW_MS = void 0;
const prisma_1 = require("../lib/prisma");
exports.PAYMENT_WINDOW_MS = 10 * 60 * 1000;
const nextPaymentExpiryDate = (base = new Date()) => new Date(base.getTime() + exports.PAYMENT_WINDOW_MS);
exports.nextPaymentExpiryDate = nextPaymentExpiryDate;
const computePaymentTiming = (order) => {
    const now = Date.now();
    const expiryMs = order.paymentExpiresAt ? order.paymentExpiresAt.getTime() : null;
    const rawDiff = expiryMs === null ? null : expiryMs - now;
    const isExpired = order.paymentStatus === 'PAYMENT_EXPIRED' || (rawDiff !== null && rawDiff <= 0);
    const secondsUntilExpiry = rawDiff === null ? null : Math.max(0, Math.floor(rawDiff / 1000));
    return { isExpired, secondsUntilExpiry };
};
exports.computePaymentTiming = computePaymentTiming;
const canRetryPayment = (order) => order.paymentStatus === 'PAYMENT_EXPIRED' && !order.paidAt;
exports.canRetryPayment = canRetryPayment;
const expirePendingPayments = async () => {
    const now = new Date();
    await prisma_1.prisma.order.updateMany({
        where: {
            paymentStatus: 'PENDING_PAYMENT',
            paidAt: null,
            paymentExpiresAt: { lt: now }
        },
        data: {
            paymentStatus: 'PAYMENT_EXPIRED',
            expiredAt: now,
            status: 'EXPIRED',
            statusUpdatedAt: now
        }
    });
};
exports.expirePendingPayments = expirePendingPayments;
