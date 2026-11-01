import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { paymentFlowService } from './paymentFlowService';
import { yookassaService } from './yookassaService';
import { yookassaWebhookService } from './yookassaWebhookService';

const original = {
  transaction: prisma.$transaction,
  expire: prisma.order.updateMany,
  getPayment: yookassaService.getPayment,
  createPayment: yookassaService.createPayment,
  handlePaymentSignal: yookassaWebhookService.handlePaymentSignal
};

test.afterEach(() => {
  (prisma.$transaction as any) = original.transaction;
  (prisma.order.updateMany as any) = original.expire;
  (yookassaService.getPayment as any) = original.getPayment;
  (yookassaService.createPayment as any) = original.createPayment;
  (yookassaWebhookService.handlePaymentSignal as any) = original.handlePaymentSignal;
});

const setup = (providerStatus: string) => {
  const order: any = {
    id: 'order-1', buyerId: 'buyer-1', status: 'EXPIRED', paymentStatus: 'PAYMENT_EXPIRED',
    paidAt: null, paymentId: 'payment-a', total: 150000, currency: 'RUB',
    shippingSnapshot: { packages: [{}] }, deliveryAmountKopecks: 20000
  };
  const paymentA: any = { id: 'payment-a', orderId: order.id, externalId: 'provider-a', status: 'PENDING', amount: order.total, currency: order.currency };
  let creates = 0;
  (prisma.order.updateMany as any) = async () => ({ count: 0 });
  (yookassaService.getPayment as any) = async () => ({ id: 'provider-a', status: providerStatus, amount: { value: '1500.00', currency: 'RUB' }, metadata: { orderId: order.id } });
  (yookassaService.createPayment as any) = async () => { creates++; return { id: 'provider-b', confirmationUrl: 'https://example.test/pay-b', payload: {} }; };
  (prisma.$transaction as any) = async (callback: any) => callback({
    $queryRaw: async () => [],
    order: {
      findFirst: async () => ({ ...order }),
      findUnique: async () => ({ ...order }),
      update: async ({ data }: any) => Object.assign(order, data)
    },
    payment: {
      findUnique: async () => ({ ...paymentA }),
      create: async () => ({ id: 'payment-b' }),
      update: async () => ({})
    }
  });
  return { order, getCreates: () => creates };
};

test('retry refuses a still pending provider attempt', async () => {
  const f = setup('pending');
  await assert.rejects(() => paymentFlowService.retryPayment('order-1', 'buyer-1'), /PAYMENT_ATTEMPT_ACTIVE/);
  assert.equal(f.getCreates(), 0);
});

test('retry verifies canceled provider attempt before creating another', async () => {
  const f = setup('canceled');
  const result = await paymentFlowService.retryPayment('order-1', 'buyer-1');
  assert.equal(f.getCreates(), 1);
  assert.equal(result.paymentStatus, 'PENDING_PAYMENT');
});

test('retry reconciles a verified old success instead of creating another attempt', async () => {
  const f = setup('succeeded');
  (yookassaWebhookService.handlePaymentSignal as any) = async (_event: string, signal: any) => {
    assert.equal(signal.externalId, 'provider-a');
    return { reason: 'APPLIED', orderId: 'order-1' };
  };
  const result = await paymentFlowService.retryPayment('order-1', 'buyer-1');
  assert.equal(result.paymentStatus, 'PAID');
  assert.equal(f.getCreates(), 0);
});
