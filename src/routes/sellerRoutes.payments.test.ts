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
const originalSellerPayoutMethodFindMany = (prisma as any).sellerPayoutMethod?.findMany;
let lastOrderFindManyArgs: any = null;

const installPrismaMocks = () => {
  (prisma.user.findUnique as unknown as (args: any) => Promise<any>) = async () => ({
    role: 'SELLER',
    sellerProfile: { id: 'sp-1', status: 'APPROVED' }
  });

  (prisma.order.findMany as unknown as (args: any) => Promise<any>) = async (args: any) => {
    lastOrderFindManyArgs = args;
    return ([
    {
      id: 'order-awaiting',
      publicNumber: 'PF-101',
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
      sellerPayouts: []
    },
    {
      id: 'order-frozen',
      publicNumber: 'PF-102',
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
      sellerPayouts: []
    },
    {
      id: 'order-paid-out',
      publicNumber: 'PF-103',
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
      sellerPayouts: [{
        id: 'sp-paid',
        createdAt: new Date('2026-03-27T10:00:00.000Z'),
        succeededAt: new Date('2026-03-27T11:00:00.000Z'),
        status: 'SUCCEEDED',
        amountKopecks: 7000,
        payoutMethod: { methodType: 'BANK_CARD', maskedLabel: 'Mir •••• 2537', cardLast4: '2537' }
      }]
    },
    {
      id: 'order-blocked',
      publicNumber: 'PF-104',
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
          createdAt: new Date('2026-03-16T10:00:00.000Z')
        }
      ],
      sellerPayouts: []
    }
    ]);
  };

  (prisma as any).sellerPayoutMethod = (prisma as any).sellerPayoutMethod ?? {};
  (prisma as any).sellerPayoutMethod.findMany = async () => ([
    {
      id: 'method-1',
      provider: 'YOOKASSA',
      methodType: 'BANK_CARD',
      status: 'ACTIVE',
      isDefault: true,
      maskedLabel: 'Mir •••• 2537',
      cardLast4: '2537',
      cardType: 'Mir',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-01T00:00:00.000Z')
    }
  ]);
};

test.beforeEach(() => {
  lastOrderFindManyArgs = null;
  installPrismaMocks();
});

test.after(() => {
  (prisma.user.findUnique as any) = originalUserFindUnique;
  (prisma.order.findMany as any) = originalOrderFindMany;
  if ((prisma as any).sellerPayoutMethod && originalSellerPayoutMethodFindMany) {
    (prisma as any).sellerPayoutMethod.findMany = originalSellerPayoutMethodFindMany;
  }
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
    refundedKopecks: 3000,
    blockedKopecks: 0,
    awaitingPayoutRubles: '100.00',
    frozenRubles: '50.00',
    paidOutRubles: '70.00',
    refundedRubles: '30.00',
    blockedRubles: '0.00'
  });

  assert.deepEqual(response.body.data.nextPayout, {
    scheduledAt: null,
    amountKopecks: 15000,
    amountRubles: '150.00',
    orderCount: 2,
    payoutScheduleType: 'MANUAL'
  });

  assert.equal(response.body.data.payoutQueue.length, 2);
  assert.equal(response.body.data.payoutHistory.length, 1);
  assert.equal(response.body.data.payoutQueue[0].publicNumber, 'PF-101');

  const blockedAdjustments = response.body.data.adjustments.filter((item: any) => item.type === 'BLOCKED');
  assert.equal(blockedAdjustments.length, 1);

  const refundAdjustments = response.body.data.adjustments.filter((item: any) => item.type === 'REFUND');
  assert.equal(refundAdjustments.length, 1);
});

test('GET /seller/payments supports search by public number', async () => {
  const response = await request(buildApp())
    .get('/seller/payments?search=%23101')
    .set('Authorization', `Bearer ${accessToken}`);

  assert.equal(response.status, 200);
  assert.equal(lastOrderFindManyArgs?.where?.OR?.[0]?.publicNumber?.contains, '#101');
  assert.equal(lastOrderFindManyArgs?.where?.OR?.[1]?.publicNumber?.endsWith, '101');
});
