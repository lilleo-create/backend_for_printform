import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sellerRoutes } from './sellerRoutes';
import { orderRoutes } from './orderRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { orderCompletionService } from '../services/orderCompletionService';

const app = express();
app.use(express.json());
app.use('/seller', sellerRoutes);
app.use('/orders', orderRoutes);
app.use(errorHandler);
const auth = `Bearer ${jwt.sign({ userId: 'seller-1', role: 'SELLER', scope: 'access' }, env.jwtSecret)}`;

const original = {
  production: env.isProduction,
  userFind: prisma.user.findUnique,
  orderFind: prisma.order.findFirst,
  orderFindUnique: prisma.order.findUnique,
  orderUpdateMany: prisma.order.updateMany,
  transaction: prisma.$transaction,
  complete: orderCompletionService.completeOrderFromDeliveryReceipt,
  release: orderCompletionService.releaseFundsForCompletedOrder
};

const harness = () => {
  const order: any = {
    id: 'order-1', status: 'PAID', paymentStatus: 'PAID', paidAt: new Date(),
    isPacked: false, readyForShipmentAt: null, cdekOrderId: null,
    shipment: null, completedAt: null, fundsReleasedAt: null
  };
  let writes = 0;
  let releases = 0;
  (env as any).isProduction = true;
  (prisma.user.findUnique as any) = async () => ({ role: 'SELLER', sellerProfile: { id: 'profile-1', status: 'APPROVED' } });
  (prisma.order.findFirst as any) = async () => order;
  (prisma.order.findUnique as any) = async () => order;
  (prisma.order.updateMany as any) = async ({ where, data }: any) => {
    if (where.status !== order.status || order.readyForShipmentAt) return { count: 0 };
    writes++;
    Object.assign(order, data);
    return { count: 1 };
  };
  (prisma.$transaction as any) = async (callback: any) => callback({
    $queryRaw: async () => [{ id: order.id }],
    order: {
      findFirst: async () => order,
      update: async ({ data }: any) => { writes++; Object.assign(order, data); return order; }
    },
    orderShipment: { findUnique: async () => order.shipment }
  });
  (orderCompletionService.completeOrderFromDeliveryReceipt as any) = async () => {
    throw new Error('SELLER_COMPLETION_FORBIDDEN');
  };
  (orderCompletionService.releaseFundsForCompletedOrder as any) = async () => {
    releases++;
    throw new Error('SELLER_RELEASE_FORBIDDEN');
  };
  return { order, get writes() { return writes; }, get releases() { return releases; } };
};

test('unpaid order cannot set isPacked', async () => {
  const h = harness();
  h.order.paymentStatus = 'PENDING_PAYMENT';
  h.order.paidAt = null;
  const response = await request(app).patch('/seller/orders/order-1/fulfillment-steps')
    .set('Authorization', auth).send({ isPacked: true });
  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'PAYMENT_REQUIRED');
  assert.equal(h.order.isPacked, false);
});

test('refunded paidAt cannot restart production or change packing', async () => {
  const h = harness();
  h.order.paymentStatus = 'PARTIALLY_REFUNDED';
  const start = await request(app).patch('/seller/orders/order-1/status')
    .set('Authorization', auth).send({ status: 'PRINTING' });
  const packing = await request(app).patch('/seller/orders/order-1/fulfillment-steps')
    .set('Authorization', auth).send({ isPacked: true });
  assert.equal(start.status, 409);
  assert.equal(packing.status, 409);
  assert.equal(h.writes, 0);
});

test('PAID to PRINTING allowed; backward and carrier transitions rejected', async () => {
  const h = harness();
  const start = await request(app).patch('/seller/orders/order-1/status')
    .set('Authorization', auth).send({ status: 'PRINTING' });
  assert.equal(start.status, 200);
  assert.equal(h.order.status, 'PRINTING');
  for (const status of ['PAID', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'READY_FOR_PICKUP', 'DELIVERED', 'RETURNED', 'READY_FOR_SHIPMENT']) {
    const response = await request(app).patch('/seller/orders/order-1/status')
      .set('Authorization', auth).send({ status });
    assert.equal(response.status, 409, status);
    assert.equal(h.order.status, 'PRINTING');
  }
  assert.equal(h.releases, 0);
  assert.equal(h.order.completedAt, null);
});

test('production mark-received and shipment-stage cannot mutate or release', async () => {
  const h = harness();
  const received = await request(app).post('/seller/orders/order-1/mark-received')
    .set('Authorization', auth).send({});
  const stage = await request(app).patch('/seller/orders/order-1/shipment-stage')
    .set('Authorization', auth).send({ stage: 'READY_FOR_PICKUP' });
  const testReceipt = await request(app).post('/seller/orders/order-1/mark-received/test')
    .set('Authorization', auth).send({});
  const legacyReady = await request(app).post('/orders/order-1/ready-for-shipment')
    .set('Authorization', auth).send({});
  assert.equal(received.status, 410);
  assert.equal(received.body.error.code, 'MANUAL_DELIVERY_CONFIRMATION_DISABLED');
  assert.equal(stage.status, 410);
  assert.equal(stage.body.error.code, 'MANUAL_SHIPMENT_STATUS_DISABLED');
  assert.equal(testReceipt.status, 403);
  assert.equal(legacyReady.status, 410);
  assert.equal(h.writes, 0);
  assert.equal(h.releases, 0);
});

test('legacy fulfillment endpoint cannot mark a parcel packed without measurements', async () => {
  const h = harness();
  const call = (value: boolean) => request(app).patch('/seller/orders/order-1/fulfillment-steps')
    .set('Authorization', auth).send({ isPacked: value });
  const blocked = await call(true);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'PACKED_PARCEL_REQUIRED');
  assert.equal(h.order.isPacked, false);
  assert.equal(h.writes, 0);
});

test.after(() => {
  (env as any).isProduction = original.production;
  (prisma.user.findUnique as any) = original.userFind;
  (prisma.order.findFirst as any) = original.orderFind;
  (prisma.order.findUnique as any) = original.orderFindUnique;
  (prisma.order.updateMany as any) = original.orderUpdateMany;
  (prisma.$transaction as any) = original.transaction;
  (orderCompletionService.completeOrderFromDeliveryReceipt as any) = original.complete;
  (orderCompletionService.releaseFundsForCompletedOrder as any) = original.release;
});
