import { prisma } from '../lib/prisma';

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const asTx = (tx?: TxClient) => tx ?? prisma;

const isTerminalPayoutStatus = (status: string | null | undefined) =>
  status === 'RELEASED' || status === 'PAID';

const resolveOrderFees = (order: any) => {
  const grossAmountMinor = Number(order.grossAmountKopecks ?? order.total ?? 0);
  const platformFeeMinor = Number(order.platformFeeKopecks ?? 0);
  const providerFeeMinor = Number(order.acquiringFeeKopecks ?? 0);
  const serviceFeeMinor = Number(order.serviceFeeKopecks ?? platformFeeMinor + providerFeeMinor);
  const sellerNetAmountMinor = Number(order.sellerNetAmountKopecks ?? Math.max(0, grossAmountMinor - serviceFeeMinor));
  return { grossAmountMinor, platformFeeMinor, providerFeeMinor, serviceFeeMinor, sellerNetAmountMinor };
};

export const payoutService = {
  buildOrderFinanceBreakdown(order: any) {
    return resolveOrderFees(order);
  },

  async releaseFundsForCompletedOrder(orderId: string, tx?: TxClient) {
    const db = asTx(tx) as any;
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return { created: false, skipped: 'ORDER_NOT_FOUND' as const };

    if (order.fundsReleasedAt || isTerminalPayoutStatus(order.payoutStatus)) {
      return { created: false, skipped: 'ALREADY_RELEASED' as const };
    }

    if (order.paymentStatus !== 'PAID') {
      return { created: false, skipped: 'ORDER_NOT_PAID' as const };
    }

    if (['CANCELLED', 'RETURNED'].includes(order.status)) {
      await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
      return { created: false, skipped: 'ORDER_BLOCKED' as const };
    }

    const sellerItem = await db.orderItem.findFirst({
      where: { orderId },
      include: { product: { select: { sellerId: true } } }
    });
    if (!sellerItem?.product?.sellerId) {
      return { created: false, skipped: 'SELLER_NOT_FOUND' as const };
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

  async releaseForDeliveredOrder(orderId: string, tx?: TxClient) {
    return this.releaseFundsForCompletedOrder(orderId, tx);
  },

  async blockForOrder(orderId: string, tx?: TxClient) {
    const db = asTx(tx) as any;
    await db.order.update({ where: { id: orderId }, data: { payoutStatus: 'BLOCKED' } });
  }
};
