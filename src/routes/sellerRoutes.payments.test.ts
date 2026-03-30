import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sellerRoutes } from './sellerRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/seller', sellerRoutes);
  app.use(errorHandler);
  return app;
};

const userId = 'seller-user-1';
const accessToken = jwt.sign({ userId, role: 'SELLER', scope: 'access' }, env.jwtSecret);

const originalUserFindUnique = prisma.user.findUnique;
const originalOrderFindMany = prisma.order.findMany;

const installPrismaMocks = () => {
  (prisma.user.findUnique as unknown as (args: any) => Promise<any>) = async () => ({
    role: 'SELLER',
    sellerProfile: { id: 'sp-1', status: 'APPROVED' }
  });

  (prisma.order.findMany as unknown as (args: any) => Promise<any>) = async () => ([
    {
      id: 'order-awaiting',
      total: 12000,
      grossAmountKopecks: 12000,
      platformFeeKopecks: 2000,
      sellerNetAmountKopecks: 10000,
      currency: 'RUB',
      payoutStatus: 'RELEASED',
      paymentStatus: 'PAID',
      status: 'IN_TRANSIT',
      createdAt: new Date('2026-03-20T09:00:00.000Z'),
      paidAt: new Date('2026-03-20T10:00:00.000Z'),
      refunds: [],
      payout: {
        id: 'po-awaiting',
        createdAt: new Date('2026-03-25T10:00:00.000Z'),
        status: 'READY',
        amount: 10000
      }
    },
    {
      id: 'order-frozen',
      total: 6000,
      grossAmountKopecks: 6000,
      platformFeeKopecks: 1000,
      sellerNetAmountKopecks: 5000,
      currency: 'RUB',
      payoutStatus: 'HOLD',
      paymentStatus: 'PAID',
      status: 'PAID',
      createdAt: new Date('2026-03-26T09:00:00.000Z'),
      paidAt: new Date('2026-03-26T10:00:00.000Z'),
      refunds: [],
      payout: null
    },
    {
      id: 'order-paid-out',
      total: 8000,
      grossAmountKopecks: 8000,
      platformFeeKopecks: 1000,
      sellerNetAmountKopecks: 7000,
      currency: 'RUB',
      payoutStatus: 'PAID',
      paymentStatus: 'PAID',
      status: 'DELIVERED',
      createdAt: new Date('2026-03-18T09:00:00.000Z'),
      paidAt: new Date('2026-03-18T10:00:00.000Z'),
      refunds: [],
      payout: {
        id: 'po-paid',
        createdAt: new Date('2026-03-27T10:00:00.000Z'),
        status: 'PAID',
        amount: 7000
      }
    },
    {
      id: 'order-blocked',
      total: 4000,
      grossAmountKopecks: 4000,
      platformFeeKopecks: 1000,
      sellerNetAmountKopecks: 3000,
      currency: 'RUB',
      payoutStatus: 'BLOCKED',
      paymentStatus: 'REFUNDED',
      status: 'CANCELLED',
      createdAt: new Date('2026-03-15T09:00:00.000Z'),
      paidAt: new Date('2026-03-15T10:00:00.000Z'),
      refunds: [
        {
          id: 'refund-1',
          amount: 3000,
          status: 'SUCCEEDED',
          reason: 'buyer_request',
          createdAt: new Date('2026-03-16T10:00:00.000Z')
        }
      ],
      payout: null
    }
  ]);
};

test.beforeEach(() => {
  installPrismaMocks();
});

test.after(() => {
  (prisma.user.findUnique as any) = originalUserFindUnique;
  (prisma.order.findMany as any) = originalOrderFindMany;
});

test('GET /seller/payments returns finance-oriented payload for seller accounting tab', async () => {
  const response = await request(buildApp())
    .get('/seller/payments')
    .set('Authorization', `Bearer ${accessToken}`);

  assert.equal(response.status, 200);

  assert.deepEqual(response.body.data.summary, {
    awaitingPayoutKopecks: 10000,
    frozenKopecks: 5000,
    paidOutKopecks: 7000,
    blockedKopecks: 3000,
    awaitingPayoutRubles: '100.00',
    frozenRubles: '50.00',
    paidOutRubles: '70.00',
    blockedRubles: '30.00'
  });

  assert.deepEqual(response.body.data.nextPayout, {
    scheduledAt: null,
    amountKopecks: 15000,
    amountRubles: '150.00',
    orderCount: 2,
    payoutScheduleType: 'MANUAL'
  });

  assert.equal(response.body.data.activeOrders.length, 2);
  assert.equal(response.body.data.payoutQueue.length, 2);
  assert.equal(response.body.data.payoutHistory.length, 2);

  const blockedAdjustments = response.body.data.adjustments.filter((item: any) => item.type === 'blocked');
  assert.equal(blockedAdjustments.length, 1);

  const refundAdjustments = response.body.data.adjustments.filter((item: any) => item.type === 'refund');
  assert.ok(refundAdjustments.length >= 1);
});
