import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { money } from '../utils/money';
import { yookassaService } from './yookassaService';

export class YooKassaWebhookRetryableError extends Error {
  constructor() {
    super('YOOKASSA_VERIFICATION_UNAVAILABLE');
  }
}

type PaymentEvent = 'payment.succeeded' | 'payment.canceled';
type Signal = { externalId: string; bodyOrderId?: string };
type Result = { orderId?: string; reason: string };

const skipped = (reason: string, orderId?: string): Result => ({ reason, orderId });

// Payment.amount, Refund.amount and Order.total are stored in kopecks.
const providerAmountKopecks = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) return null;
  const amount = money.toKopecks(Number(value));
  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
};

const paymentBindingError = (payment: any, order: any, bodyOrderId?: string): string | null => {
  if (!order || payment.orderId !== order.id) return 'LOCAL_ORDER_MISMATCH';
  if (payment.provider !== 'yookassa') return 'LOCAL_PROVIDER_MISMATCH';
  if (bodyOrderId && bodyOrderId !== payment.orderId) return 'BODY_ORDER_MISMATCH';
  if (payment.amount !== order.total || payment.currency !== order.currency) return 'LOCAL_AMOUNT_MISMATCH';
  if (order.paymentId && order.paymentId !== payment.id) return 'LOCAL_PAYMENT_MISMATCH';
  return null;
};

const refundBindingError = (refund: any, payment: any, order: any, bodyOrderId?: string): string | null => {
  if (!payment || !order || refund.orderId !== order.id || payment.orderId !== order.id) return 'LOCAL_ORDER_MISMATCH';
  if (payment.provider !== 'yookassa' || refund.paymentId !== payment.externalId) return 'LOCAL_PAYMENT_MISMATCH';
  if (bodyOrderId && bodyOrderId !== refund.orderId) return 'BODY_ORDER_MISMATCH';
  if (refund.currency !== payment.currency || refund.currency !== order.currency ||
      payment.amount !== order.total || refund.amount > payment.amount || refund.amount <= 0) {
    return 'LOCAL_AMOUNT_MISMATCH';
  }
  return null;
};

export const yookassaWebhookService = {
  async handlePaymentSignal(event: PaymentEvent, signal: Signal): Promise<Result> {
    const payment = await prisma.payment.findFirst({ where: { externalId: signal.externalId } });
    if (!payment) return skipped('PAYMENT_UNKNOWN');
    const order = await prisma.order.findUnique({ where: { id: payment.orderId } });
    const bindingError = paymentBindingError(payment, order, signal.bodyOrderId);
    if (bindingError) return skipped(bindingError, payment.orderId);

    let provider: Awaited<ReturnType<typeof yookassaService.getPayment>>;
    try {
      provider = await yookassaService.getPayment(signal.externalId);
    } catch {
      throw new YooKassaWebhookRetryableError();
    }

    const expectedStatus = event === 'payment.succeeded' ? 'succeeded' : 'canceled';
    if (provider.id !== payment.externalId) return skipped('PROVIDER_ID_MISMATCH', payment.orderId);
    if (provider.status !== expectedStatus) return skipped('PROVIDER_STATUS_MISMATCH', payment.orderId);
    if (!provider.metadata?.orderId || provider.metadata.orderId !== payment.orderId) {
      return skipped('PROVIDER_ORDER_MISMATCH', payment.orderId);
    }
    if (provider.amount?.currency !== payment.currency) return skipped('PROVIDER_CURRENCY_MISMATCH', payment.orderId);
    if (providerAmountKopecks(provider.amount?.value) !== payment.amount) {
      return skipped('PROVIDER_AMOUNT_MISMATCH', payment.orderId);
    }

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Payment" WHERE id = ${payment.id} FOR UPDATE`;
      const currentPayment = await tx.payment.findFirst({ where: { externalId: signal.externalId } });
      const currentOrder = currentPayment
        ? await tx.order.findUnique({ where: { id: currentPayment.orderId } })
        : null;
      if (!currentPayment) return skipped('PAYMENT_UNKNOWN');
      const currentBindingError = paymentBindingError(currentPayment, currentOrder, signal.bodyOrderId);
      if (currentBindingError || currentPayment.id !== payment.id ||
          currentPayment.amount !== payment.amount || currentPayment.currency !== payment.currency) {
        return skipped(currentBindingError ?? 'LOCAL_PAYMENT_CHANGED', payment.orderId);
      }
      if (!currentOrder) return skipped('LOCAL_ORDER_MISMATCH', payment.orderId);

      if (event === 'payment.succeeded') {
        if (currentPayment.status === 'SUCCEEDED' && currentOrder.paymentStatus === 'PAID') {
          return skipped('DUPLICATE', currentOrder.id);
        }
        if (!['PENDING', 'SUCCEEDED'].includes(currentPayment.status) ||
            !['CREATED', 'EXPIRED'].includes(currentOrder.status) ||
            !['PENDING_PAYMENT', 'PAYMENT_EXPIRED'].includes(currentOrder.paymentStatus)) {
          return skipped('PAYMENT_STATE_INVALID', currentOrder.id);
        }
        if (currentPayment.status !== 'SUCCEEDED') {
          await tx.payment.update({ where: { id: currentPayment.id }, data: { status: 'SUCCEEDED' } });
        }
        await tx.order.update({
          where: { id: currentOrder.id },
          data: {
            status: 'PAID', paymentStatus: 'PAID', paymentExpiresAt: null, expiredAt: null,
            paidAt: currentOrder.paidAt ?? new Date(),
            paymentProvider: 'yookassa', paymentId: currentPayment.id, payoutStatus: 'HOLD'
          }
        });
        return skipped('APPLIED', currentOrder.id);
      }

      if (currentPayment.status === 'CANCELED' && currentOrder.paymentStatus === 'PAYMENT_EXPIRED') {
        return skipped('DUPLICATE', currentOrder.id);
      }
      if (currentPayment.status !== 'PENDING' || currentOrder.status !== 'CREATED' ||
          !['PENDING_PAYMENT', 'PAYMENT_EXPIRED'].includes(currentOrder.paymentStatus)) {
        return skipped('PAYMENT_STATE_INVALID', currentOrder.id);
      }
      await tx.payment.update({ where: { id: currentPayment.id }, data: { status: 'CANCELED' } });
      await tx.order.update({ where: { id: currentOrder.id }, data: { paymentStatus: 'PAYMENT_EXPIRED' } });
      return skipped('APPLIED', currentOrder.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  },

  async handleRefundSignal(signal: Signal): Promise<Result> {
    const refund = await prisma.refund.findFirst({ where: { externalId: signal.externalId } });
    if (!refund) return skipped('REFUND_UNKNOWN');
    const payment = await prisma.payment.findFirst({ where: { externalId: refund.paymentId } });
    const order = await prisma.order.findUnique({ where: { id: refund.orderId } });
    const bindingError = refundBindingError(refund, payment, order, signal.bodyOrderId);
    if (bindingError) return skipped(bindingError, refund.orderId);
    if (!payment) return skipped('LOCAL_PAYMENT_MISMATCH', refund.orderId);

    let provider: Awaited<ReturnType<typeof yookassaService.getRefund>>;
    try {
      provider = await yookassaService.getRefund(signal.externalId);
    } catch {
      throw new YooKassaWebhookRetryableError();
    }
    if (provider.id !== refund.externalId) return skipped('PROVIDER_ID_MISMATCH', refund.orderId);
    if (provider.status !== 'succeeded') return skipped('PROVIDER_STATUS_MISMATCH', refund.orderId);
    if (provider.payment_id !== payment.externalId) return skipped('PROVIDER_PAYMENT_MISMATCH', refund.orderId);
    if (provider.metadata?.orderId && provider.metadata.orderId !== refund.orderId) {
      return skipped('PROVIDER_ORDER_MISMATCH', refund.orderId);
    }
    if (provider.amount?.currency !== refund.currency) return skipped('PROVIDER_CURRENCY_MISMATCH', refund.orderId);
    if (providerAmountKopecks(provider.amount?.value) !== refund.amount) {
      return skipped('PROVIDER_AMOUNT_MISMATCH', refund.orderId);
    }

    return prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Refund" WHERE id = ${refund.id} FOR UPDATE`;
      const currentRefund = await tx.refund.findFirst({ where: { externalId: signal.externalId } });
      if (!currentRefund) return skipped('REFUND_UNKNOWN');
      const currentPayment = await tx.payment.findFirst({ where: { externalId: currentRefund.paymentId } });
      const currentOrder = await tx.order.findUnique({ where: { id: currentRefund.orderId } });
      const currentBindingError = refundBindingError(currentRefund, currentPayment, currentOrder, signal.bodyOrderId);
      if (currentBindingError || currentRefund.id !== refund.id || currentRefund.amount !== refund.amount) {
        return skipped(currentBindingError ?? 'LOCAL_REFUND_CHANGED', refund.orderId);
      }
      if (!currentOrder || !currentPayment) return skipped('LOCAL_ORDER_MISMATCH', refund.orderId);
      if (currentRefund.status === 'SUCCEEDED') return skipped('DUPLICATE', currentOrder.id);
      if (currentRefund.status !== 'PENDING' || currentPayment.status !== 'SUCCEEDED' ||
          !['PAID', 'REFUND_PENDING', 'PARTIALLY_REFUNDED'].includes(currentOrder.paymentStatus)) {
        return skipped('REFUND_STATE_INVALID', currentOrder.id);
      }
      await tx.refund.updateMany({ where: { id: currentRefund.id, status: 'PENDING' }, data: { status: 'SUCCEEDED' } });
      await tx.order.update({
        where: { id: currentOrder.id },
        data: {
          paymentStatus: currentRefund.amount === currentOrder.total ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          payoutStatus: 'BLOCKED',
          yookassaDealStatus: currentOrder.yookassaDealId ? 'refunded' : currentOrder.yookassaDealStatus
        }
      });
      return skipped('APPLIED', currentOrder.id);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
};
