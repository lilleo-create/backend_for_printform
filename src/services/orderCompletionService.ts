import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { payoutService } from './payoutService';

type TxClient = Prisma.TransactionClient;

type CompletionSource = 'cdek_webhook' | 'cdek_sync' | 'manual_test';

const terminalOrderStatuses = new Set(['CANCELLED', 'RETURNED', 'EXPIRED']);

const toDb = (tx?: TxClient) => (tx ?? prisma) as unknown as PrismaClient;

export const orderCompletionService = {
  async completeOrderFromDeliveryReceipt(orderId: string, source: CompletionSource, tx?: TxClient) {
    const db = toDb(tx);
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return { completed: false, reason: 'ORDER_NOT_FOUND' as const };

    if (!order.paidAt && order.paymentStatus !== 'PAID') {
      return { completed: false, reason: 'ORDER_NOT_PAID' as const };
    }

    if (terminalOrderStatuses.has(order.status)) {
      return { completed: false, reason: 'ORDER_TERMINAL' as const };
    }

    if ((order as any).completedAt) {
      return { completed: false, reason: 'ALREADY_COMPLETED' as const };
    }

    await (db.order.update as any)({
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

  async releaseFundsForCompletedOrder(orderId: string, tx?: TxClient) {
    const db = toDb(tx);
    const order = await db.order.findUnique({ where: { id: orderId } });
    if (!order) return { released: false, reason: 'ORDER_NOT_FOUND' as const };
    if ((order as any).fundsReleasedAt) return { released: false, reason: 'ALREADY_RELEASED' as const };

    const payoutResult = await payoutService.releaseForDeliveredOrder(orderId, tx);
    if (payoutResult.skipped === 'ALREADY_RELEASED') {
      await (db.order.update as any)({ where: { id: orderId }, data: { fundsReleasedAt: new Date() } });
      return { released: false, reason: 'ALREADY_RELEASED' as const };
    }

    if (payoutResult.skipped) return { released: false, reason: payoutResult.skipped };

    await (db.order.update as any)({ where: { id: orderId }, data: { fundsReleasedAt: new Date() } });

    return { released: true, reason: null };
  }
};
