"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.payoutService = void 0;
const prisma_1 = require("../lib/prisma");
const yookassaService_1 = require("./yookassaService");
const asTx = (tx) => tx ?? prisma_1.prisma;
const safeDealEnabled = () => (process.env.YOOKASSA_SAFE_DEAL_ENABLED ?? '').toLowerCase() === 'true';
const payoutDestinationData = () => {
    const raw = process.env.YOOKASSA_PAYOUT_DESTINATION_DATA_JSON;
    if (!raw)
        return undefined;
    return JSON.parse(raw);
};
const isTerminalPayoutStatus = (status) => status === 'RELEASED' || status === 'PAID';
exports.payoutService = {
    async releaseForDeliveredOrder(orderId, tx) {
        const db = asTx(tx);
        const order = await db.order.findUnique({ where: { id: orderId } });
        if (!order)
            return { created: false, skipped: 'ORDER_NOT_FOUND' };
        if (isTerminalPayoutStatus(order.payoutStatus)) {
            return { created: false, skipped: 'ALREADY_RELEASED' };
        }
        if (['CANCELLED', 'RETURNED'].includes(order.status)) {
            await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
            return { created: false, skipped: 'ORDER_BLOCKED' };
        }
        const existingPayout = await db.payout.findUnique({ where: { orderId } });
        if (!existingPayout) {
            const sellerItem = await db.orderItem.findFirst({
                where: { orderId },
                include: { product: { select: { sellerId: true } } }
            });
            if (!sellerItem?.product?.sellerId) {
                return { created: false, skipped: 'SELLER_NOT_FOUND' };
            }
            await db.payout.create({
                data: {
                    orderId,
                    sellerId: sellerItem.product.sellerId,
                    amount: order.sellerNetAmountKopecks ?? order.total,
                    currency: order.currency,
                    status: 'READY'
                }
            });
        }
        const sellerAmountKopecks = order.sellerNetAmountKopecks ?? order.total;
        if (safeDealEnabled() && order.yookassaDealId) {
            try {
                const payoutDestination = payoutDestinationData();
                if (payoutDestination) {
                    const yookassaPayout = await yookassaService_1.yookassaService.createPayoutInDeal({
                        orderId,
                        dealId: order.yookassaDealId,
                        sellerAmountKopecks,
                        currency: order.currency,
                        payoutDestinationData: payoutDestination
                    });
                    await db.order.update({
                        where: { id: orderId },
                        data: {
                            payoutStatus: 'PROCESSING',
                            yookassaPayoutId: yookassaPayout.id,
                            yookassaDealStatus: yookassaPayout.status
                        }
                    });
                    return { created: !existingPayout, skipped: null };
                }
            }
            catch (error) {
                console.error('[PAYOUT][YOOKASSA_CREATE_FAILED]', {
                    orderId,
                    dealId: order.yookassaDealId,
                    error,
                    stack: error instanceof Error ? error.stack : undefined
                });
            }
        }
        await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'RELEASED' } });
        return { created: !existingPayout, skipped: null };
    },
    async blockForOrder(orderId, tx) {
        const db = asTx(tx);
        await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
    }
};
