import { prisma } from '../lib/prisma';
import { OrderPaymentStatus } from '@prisma/client';

export const PAYMENT_WINDOW_MS = 10 * 60 * 1000;

export const nextPaymentExpiryDate = (base = new Date()) => new Date(base.getTime() + PAYMENT_WINDOW_MS);

export const computePaymentTiming = (order: { paymentExpiresAt: Date | null; paymentStatus: OrderPaymentStatus }) => {
  const now = Date.now();
  const expiryMs = order.paymentExpiresAt ? order.paymentExpiresAt.getTime() : null;
  const rawDiff = expiryMs === null ? null : expiryMs - now;
  const isExpired = order.paymentStatus === 'PAYMENT_EXPIRED' || (rawDiff !== null && rawDiff <= 0);
  const secondsUntilExpiry = rawDiff === null ? null : Math.max(0, Math.floor(rawDiff / 1000));
  return { isExpired, secondsUntilExpiry };
};

export const canRetryPayment = (order: { paymentStatus: OrderPaymentStatus; paidAt: Date | null }) =>
  order.paymentStatus === 'PAYMENT_EXPIRED' && !order.paidAt;

export const expirePendingPayments = async () => {
  const now = new Date();
  await prisma.order.updateMany({
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
