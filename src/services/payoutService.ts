import { prisma } from '../lib/prisma';

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const asTx = (tx?: TxClient) => tx ?? prisma;

const isTerminalPayoutStatus = (status: string | null | undefined) =>
  status === 'RELEASED' || status === 'PAID';

export const payoutService = {
  async releaseForDeliveredOrder(orderId: string, tx?: TxClient) {
    const db = asTx(tx) as any;
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return { created: false, skipped: 'ORDER_NOT_FOUND' as const };

    if (isTerminalPayoutStatus(order.payoutStatus)) {
      return { created: false, skipped: 'ALREADY_RELEASED' as const };
    }

    if (['CANCELLED', 'RETURNED'].includes(order.status)) {
      await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
      return { created: false, skipped: 'ORDER_BLOCKED' as const };
    }

    const existingPayout = await db.payout.findUnique({ where: { orderId } });
    if (!existingPayout) {
      const sellerItem = await db.orderItem.findFirst({
        where: { orderId },
        include: { product: { select: { sellerId: true } } }
      });
      if (!sellerItem?.product?.sellerId) {
        return { created: false, skipped: 'SELLER_NOT_FOUND' as const };
      }

      await db.payout.create({
        data: {
          orderId,
          sellerId: sellerItem.product.sellerId,
          amount: order.total,
          currency: order.currency,
          status: 'READY'
        }
      });
    }

    await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'RELEASED' } });
    return { created: !existingPayout, skipped: null };
  },

  async blockForOrder(orderId: string, tx?: TxClient) {
    const db = asTx(tx) as any;
    await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
  }
};
