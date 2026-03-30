import { prisma } from '../lib/prisma';
import { yookassaService } from './yookassaService';

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const asTx = (tx?: TxClient) => tx ?? prisma;

const safeDealEnabled = () => (process.env.YOOKASSA_SAFE_DEAL_ENABLED ?? '').toLowerCase() === 'true';
const payoutDestinationData = () => {
  const raw = process.env.YOOKASSA_PAYOUT_DESTINATION_DATA_JSON;
  if (!raw) return undefined;
  return JSON.parse(raw) as Record<string, unknown>;
};

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
          const yookassaPayout = await yookassaService.createPayoutInDeal({
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
      } catch (error) {
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

  async blockForOrder(orderId: string, tx?: TxClient) {
    const db = asTx(tx) as any;
    await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
  }
};
