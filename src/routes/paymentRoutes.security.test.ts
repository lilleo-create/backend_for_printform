import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { paymentRoutes } from './paymentRoutes';
import { yookassaService } from '../services/yookassaService';
import { prisma } from '../lib/prisma';

const original = {
  paymentFindFirst: prisma.payment.findFirst,
  paymentUpdateMany: prisma.payment.updateMany,
  paymentUpdate: prisma.payment.update,
  orderFindUnique: prisma.order.findUnique,
  orderUpdate: prisma.order.update,
  orderUpdateMany: prisma.order.updateMany,
  refundFindFirst: prisma.refund.findFirst,
  refundUpdateMany: prisma.refund.updateMany,
  transaction: prisma.$transaction,
  queryRaw: prisma.$queryRaw,
  getPayment: yookassaService.getPayment,
  getRefund: (yookassaService as any).getRefund
};

const paymentSignal = (event = 'payment.succeeded', bodyOrderId = 'order-a') => ({
  type: 'notification',
  event,
  object: {
    id: 'external-a',
    status: event.split('.')[1],
    amount: { value: '204.75', currency: 'RUB' },
    metadata: { orderId: bodyOrderId }
  }
});

const refundSignal = (bodyOrderId = 'order-a') => ({
  type: 'notification',
  event: 'refund.succeeded',
  object: {
    id: 'external-refund-a',
    status: 'succeeded',
    amount: { value: '204.75', currency: 'RUB' },
    payment_id: 'external-a',
    metadata: { orderId: bodyOrderId }
  }
});

const app = express();
app.use(express.json());
app.use('/payments', paymentRoutes);

const fixture = (paid = false) => {
  const order: any = {
    id: 'order-a', total: 20475, currency: 'RUB', status: paid ? 'PAID' : 'CREATED',
    paymentStatus: paid ? 'PAID' : 'PENDING_PAYMENT',
    paymentId: 'payment-a', paidAt: paid ? new Date('2026-01-01') : null,
    yookassaDealId: null, payoutStatus: paid ? 'HOLD' : 'BLOCKED'
  };
  const payment: any = {
    id: 'payment-a', externalId: 'external-a', orderId: 'order-a', provider: 'yookassa',
    amount: 20475, currency: 'RUB', status: paid ? 'SUCCEEDED' : 'PENDING',
    payloadJson: null
  };
  const refund: any = {
    id: 'refund-a', externalId: 'external-refund-a', orderId: 'order-a',
    paymentId: 'external-a', amount: 20475, currency: 'RUB', status: 'PENDING',
    payloadJson: null
  };
  const writes = { payment: 0, order: 0, refund: 0 };
  let providerPayment: any = {
    id: 'external-a', status: 'succeeded', amount: { value: '204.75', currency: 'RUB' },
    metadata: { orderId: 'order-a' }
  };
  let providerRefund: any = {
    id: 'external-refund-a', status: 'succeeded', payment_id: 'external-a',
    amount: { value: '204.75', currency: 'RUB' }
  };
  (prisma.payment.findFirst as any) = async ({ where }: any) =>
    where?.externalId === payment.externalId ? { ...payment } : null;
  (prisma.order.findUnique as any) = async ({ where }: any) =>
    where?.id === order.id ? { ...order } : null;
  (prisma.refund.findFirst as any) = async ({ where }: any) =>
    where?.externalId === refund.externalId ? { ...refund, order: { ...order } } : null;
  (prisma.payment.updateMany as any) = async ({ where, data }: any) => {
    if (where?.externalId !== payment.externalId || payment.status === data.status) return { count: 0 };
    Object.assign(payment, data);
    writes.payment++;
    return { count: 1 };
  };
  (prisma.payment.update as any) = async ({ data }: any) => {
    Object.assign(payment, data);
    writes.payment++;
    return { ...payment };
  };
  (prisma.order.update as any) = async ({ where, data }: any) => {
    assert.equal(where.id, order.id);
    Object.assign(order, data);
    writes.order++;
    return { ...order };
  };
  (prisma.order.updateMany as any) = async ({ data }: any) => {
    Object.assign(order, data);
    writes.order++;
    return { count: 1 };
  };
  (prisma.refund.updateMany as any) = async ({ data }: any) => {
    if (refund.status === data.status) return { count: 0 };
    Object.assign(refund, data);
    writes.refund++;
    return { count: 1 };
  };
  (prisma.$transaction as any) = async (cb: any) => cb(prisma);
  (prisma.$queryRaw as any) = async () => [];
  (yookassaService.getPayment as any) = async () => providerPayment;
  (yookassaService as any).getRefund = async () => providerRefund;
  return {
    order, payment, refund, writes,
    setProviderPayment: (value: any) => { providerPayment = value; },
    setProviderRefund: (value: any) => { providerRefund = value; }
  };
};

test.afterEach(() => {
  (prisma.payment.findFirst as any) = original.paymentFindFirst;
  (prisma.payment.updateMany as any) = original.paymentUpdateMany;
  (prisma.payment.update as any) = original.paymentUpdate;
  (prisma.order.findUnique as any) = original.orderFindUnique;
  (prisma.order.update as any) = original.orderUpdate;
  (prisma.order.updateMany as any) = original.orderUpdateMany;
  (prisma.refund.findFirst as any) = original.refundFindFirst;
  (prisma.refund.updateMany as any) = original.refundUpdateMany;
  (prisma.$transaction as any) = original.transaction;
  (prisma.$queryRaw as any) = original.queryRaw;
  (yookassaService.getPayment as any) = original.getPayment;
  (yookassaService as any).getRefund = original.getRefund;
});

test('fake succeeded with provider pending cannot mark order paid', async () => {
  const f = fixture();
  f.setProviderPayment({ id: 'external-a', status: 'pending', amount: { value: '204.75', currency: 'RUB' }, metadata: { orderId: 'order-a' } });
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal()).expect(200);
  assert.equal(f.payment.status, 'PENDING');
  assert.equal(f.order.paymentStatus, 'PENDING_PAYMENT');
  assert.equal(f.order.paidAt, null);
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
});

test('body orderId cannot redirect payment to another order', async () => {
  const f = fixture();
  const orderB = { id: 'order-b', status: 'CREATED', paymentStatus: 'PENDING_PAYMENT', paidAt: null };
  const findOrder = prisma.order.findUnique;
  (prisma.order.findUnique as any) = async ({ where }: any) =>
    where.id === orderB.id ? { ...orderB } : findOrder({ where });
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal('payment.succeeded', 'order-b')).expect(200);
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
  assert.equal(orderB.paymentStatus, 'PENDING_PAYMENT');
});

test('provider metadata for another order cannot mark payment paid', async () => {
  const f = fixture();
  f.setProviderPayment({ id: 'external-a', status: 'succeeded', amount: { value: '204.75', currency: 'RUB' }, metadata: { orderId: 'order-b' } });
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal()).expect(200);
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
});

test('wrong provider amount or currency causes no mutation', async () => {
  const f = fixture();
  f.setProviderPayment({ id: 'external-a', status: 'succeeded', amount: { value: '204.74', currency: 'RUB' }, metadata: { orderId: 'order-a' } });
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal()).expect(200);
  f.setProviderPayment({ id: 'external-a', status: 'succeeded', amount: { value: '204.75', currency: 'USD' }, metadata: { orderId: 'order-a' } });
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal()).expect(200);
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
});

test('verified 204.75 RUB succeeds once and duplicate has no side effects', async () => {
  const f = fixture();
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal()).expect(200);
  assert.equal(f.payment.status, 'SUCCEEDED');
  assert.equal(f.order.status, 'PAID');
  assert.equal(f.order.paymentStatus, 'PAID');
  assert.ok(f.order.paidAt instanceof Date);
  const writes = { ...f.writes };
  const paidAt = f.order.paidAt;
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal()).expect(200);
  assert.deepEqual(f.writes, writes);
  assert.equal(f.order.paidAt, paidAt);
});

test('verified payment may complete after local payment window expires', async () => {
  const f = fixture();
  f.order.status = 'EXPIRED';
  f.order.paymentStatus = 'PAYMENT_EXPIRED';
  f.order.expiredAt = new Date('2026-01-01');
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal()).expect(200);
  assert.equal(f.order.status, 'PAID');
  assert.equal(f.order.paymentStatus, 'PAID');
  assert.equal(f.order.expiredAt, null);
});

test('late success for replaced payment cannot overwrite current payment', async () => {
  const f = fixture();
  f.order.paymentId = 'new-payment';
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal()).expect(200);
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
});

test('fake canceled with provider succeeded does not downgrade paid order', async () => {
  const f = fixture(true);
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal('payment.canceled')).expect(200);
  assert.equal(f.order.status, 'PAID');
  assert.equal(f.order.paymentStatus, 'PAID');
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
});

test('verified canceled marks local pending payment canceled', async () => {
  const f = fixture();
  f.setProviderPayment({ id: 'external-a', status: 'canceled', amount: { value: '204.75', currency: 'RUB' }, metadata: { orderId: 'order-a' } });
  await request(app).post('/payments/yookassa/webhook').send(paymentSignal('payment.canceled')).expect(200);
  assert.equal(f.payment.status, 'CANCELED');
  assert.equal(f.order.paymentStatus, 'PAYMENT_EXPIRED');
});

test('provider timeout returns retryable non-200 and mutates nothing', async () => {
  const f = fixture();
  (yookassaService.getPayment as any) = async () => { throw new Error('timeout'); };
  const response = await request(app).post('/payments/yookassa/webhook').send(paymentSignal());
  assert.ok(response.status >= 500);
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
});

test('unknown payment and malformed notification mutate nothing', async () => {
  const f = fixture();
  await request(app).post('/payments/yookassa/webhook').send({ event: 'payment.succeeded', object: { id: 'missing' } }).expect(200);
  await request(app).post('/payments/yookassa/webhook').send({}).expect(200);
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
});

test('fake refund with provider status or payment mismatch mutates nothing', async () => {
  const f = fixture(true);
  f.order.paymentStatus = 'REFUND_PENDING';
  f.setProviderRefund({ id: 'external-refund-a', status: 'pending', payment_id: 'external-a', amount: { value: '204.75', currency: 'RUB' } });
  await request(app).post('/payments/yookassa/webhook').send(refundSignal()).expect(200);
  f.setProviderRefund({ id: 'external-refund-a', status: 'succeeded', payment_id: 'external-b', amount: { value: '204.75', currency: 'RUB' } });
  await request(app).post('/payments/yookassa/webhook').send(refundSignal()).expect(200);
  assert.deepEqual(f.writes, { payment: 0, order: 0, refund: 0 });
});

test('verified refund updates refund and order once', async () => {
  const f = fixture(true);
  f.order.paymentStatus = 'REFUND_PENDING';
  await request(app).post('/payments/yookassa/webhook').send(refundSignal()).expect(200);
  assert.equal(f.refund.status, 'SUCCEEDED');
  assert.equal(f.order.paymentStatus, 'REFUNDED');
  const writes = { ...f.writes };
  await request(app).post('/payments/yookassa/webhook').send(refundSignal()).expect(200);
  assert.deepEqual(f.writes, writes);
});
