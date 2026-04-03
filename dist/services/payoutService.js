"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.payoutService = void 0;
const prisma_1 = require("../lib/prisma");
const env_1 = require("../config/env");
const asTx = (tx) => tx ?? prisma_1.prisma;
const isTerminalPayoutStatus = (status) => status === 'RELEASED' || status === 'PAID';
const resolveOrderFees = (order) => {
    const grossAmountMinor = Number(order.grossAmountKopecks ?? order.total ?? 0);
    const platformFeeMinor = Number(order.platformFeeKopecks ?? 0);
    const providerFeeMinor = Number(order.acquiringFeeKopecks ?? 0);
    const serviceFeeMinor = Number(order.serviceFeeKopecks ?? platformFeeMinor + providerFeeMinor);
    const sellerNetAmountMinor = Number(order.sellerNetAmountKopecks ?? Math.max(0, grossAmountMinor - serviceFeeMinor));
    return { grossAmountMinor, platformFeeMinor, providerFeeMinor, serviceFeeMinor, sellerNetAmountMinor };
};
exports.payoutService = {
    buildOrderFinanceBreakdown(order) {
        return resolveOrderFees(order);
    },
    async releaseFundsForCompletedOrder(orderId, tx) {
        const db = asTx(tx);
        const order = await db.order.findUnique({ where: { id: orderId } });
        if (!order)
            return { created: false, skipped: 'ORDER_NOT_FOUND' };
        if (order.fundsReleasedAt || isTerminalPayoutStatus(order.payoutStatus)) {
            return { created: false, skipped: 'ALREADY_RELEASED' };
        }
        if (order.paymentStatus !== 'PAID') {
            return { created: false, skipped: 'ORDER_NOT_PAID' };
        }
        if (env_1.env.yookassaSafeDealEnabled && !order.yookassaDealId) {
            console.error('[PAYOUT][RELEASE_SKIPPED_DEAL_MISSING]', {
                orderId,
                publicNumber: order.publicNumber ?? null,
                paymentId: order.paymentId ?? null,
                payoutStatus: order.payoutStatus ?? null
            });
            return { created: false, skipped: 'DEAL_ID_MISSING' };
        }
        if (['CANCELLED', 'RETURNED'].includes(order.status)) {
            await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
            return { created: false, skipped: 'ORDER_BLOCKED' };
        }
        const sellerItem = await db.orderItem.findFirst({
            where: { orderId },
            include: { product: { select: { sellerId: true } } }
        });
        if (!sellerItem?.product?.sellerId) {
            return { created: false, skipped: 'SELLER_NOT_FOUND' };
        }
        const sellerId = sellerItem.product.sellerId;
        const breakdown = resolveOrderFees(order);
        await db.order.update({
            where: { id: orderId },
            data: {
                payoutStatus: 'RELEASED',
                completedAt: order.completedAt ?? new Date(),
                fundsReleasedAt: new Date(),
                serviceFeeKopecks: breakdown.serviceFeeMinor,
                sellerNetAmountKopecks: breakdown.sellerNetAmountMinor
            }
        });
        await db.sellerBalanceLedgerEntry.upsert({
            where: { orderId_entryType: { orderId, entryType: 'RELEASE_TO_AVAILABLE' } },
            create: {
                orderId,
                sellerId,
                entryType: 'RELEASE_TO_AVAILABLE',
                amountKopecks: breakdown.sellerNetAmountMinor,
                metadata: {
                    grossAmountMinor: breakdown.grossAmountMinor,
                    serviceFeeMinor: breakdown.serviceFeeMinor,
                    platformFeeMinor: breakdown.platformFeeMinor,
                    providerFeeMinor: breakdown.providerFeeMinor
                }
            },
            update: {}
        });
        const existingPayout = await db.payout.findUnique({ where: { orderId } });
        if (!existingPayout) {
            await db.payout.create({
                data: {
                    orderId,
                    sellerId,
                    amount: breakdown.sellerNetAmountMinor,
                    currency: order.currency,
                    status: 'READY'
                }
            });
        }
        return { created: !existingPayout, skipped: null, finance: breakdown };
    },
    async releaseForDeliveredOrder(orderId, tx) {
        return this.releaseFundsForCompletedOrder(orderId, tx);
    },
    async blockForOrder(orderId, tx) {
        const db = asTx(tx);
        await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
    }
};
