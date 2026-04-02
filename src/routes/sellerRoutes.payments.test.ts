import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sellerRoutes } from './sellerRoutes';
import { env } from '../config/env';
import { errorHandler } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { yookassaService } from '../services/yookassaService';

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
const originalSellerPayoutMethodFindFirst = (prisma as any).sellerPayoutMethod?.findFirst;
const originalSellerPayoutMethodUpdateMany = (prisma as any).sellerPayoutMethod?.updateMany;
const originalSellerPayoutMethodUpdate = (prisma as any).sellerPayoutMethod?.update;
const originalSellerPayoutMethodCreate = (prisma as any).sellerPayoutMethod?.create;
const originalPrismaTransaction = prisma.$transaction;
const originalCreatePayoutInDeal = yookassaService.createPayoutInDeal;
const originalSellerPayoutFindMany = (prisma as any).sellerPayout?.findMany;
const originalSellerPayoutFindFirst = (prisma as any).sellerPayout?.findFirst;
const originalSellerPayoutCreate = (prisma as any).sellerPayout?.create;
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
  (prisma as any).sellerPayoutMethod.findFirst = async () => ({
    id: 'method-1',
    provider: 'YOOKASSA',
    methodType: 'BANK_CARD',
    payoutToken: 'pt_test_123',
    status: 'ACTIVE',
    isDefault: true,
    cardFirst6: '220220',
    cardLast4: '2537',
    cardType: 'Mir',
    cardIssuerCountry: 'RU',
    cardIssuerName: 'Sberbank Of Russia',
    updatedAt: new Date('2026-03-01T00:00:00.000Z')
  });
  (prisma as any).sellerPayoutMethod.updateMany = async () => ({ count: 1 });
  (prisma as any).sellerPayoutMethod.update = async (_args: any) => ({ id: 'method-1' });
  (prisma as any).sellerPayoutMethod.create = async (_args: any) => ({ id: 'method-1' });
  (prisma.$transaction as any) = async (callback: any) => callback(prisma as any);
  (prisma as any).sellerPayout = (prisma as any).sellerPayout ?? {};
  (prisma as any).sellerPayout.findMany = async () => [];
  (prisma as any).sellerPayout.findFirst = async () => null;
  (prisma as any).sellerPayout.create = async ({ data }: any) => ({ id: 'payout-1', createdAt: new Date(), updatedAt: new Date(), ...data });
  (yookassaService.createPayoutInDeal as any) = async () => ({ id: 'ext-payout-1', status: 'pending' });
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
  if ((prisma as any).sellerPayoutMethod && originalSellerPayoutMethodFindFirst) {
    (prisma as any).sellerPayoutMethod.findFirst = originalSellerPayoutMethodFindFirst;
  }
  if ((prisma as any).sellerPayoutMethod && originalSellerPayoutMethodUpdateMany) {
    (prisma as any).sellerPayoutMethod.updateMany = originalSellerPayoutMethodUpdateMany;
  }
  if ((prisma as any).sellerPayoutMethod && originalSellerPayoutMethodUpdate) {
    (prisma as any).sellerPayoutMethod.update = originalSellerPayoutMethodUpdate;
  }
  if ((prisma as any).sellerPayoutMethod && originalSellerPayoutMethodCreate) {
    (prisma as any).sellerPayoutMethod.create = originalSellerPayoutMethodCreate;
  }
  if ((prisma as any).sellerPayout && originalSellerPayoutFindMany) {
    (prisma as any).sellerPayout.findMany = originalSellerPayoutFindMany;
  }
  if ((prisma as any).sellerPayout && originalSellerPayoutFindFirst) {
    (prisma as any).sellerPayout.findFirst = originalSellerPayoutFindFirst;
  }
  if ((prisma as any).sellerPayout && originalSellerPayoutCreate) {
    (prisma as any).sellerPayout.create = originalSellerPayoutCreate;
  }
  (yookassaService.createPayoutInDeal as any) = originalCreatePayoutInDeal;
  (prisma.$transaction as any) = originalPrismaTransaction;
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

test('GET /seller/finance returns compatibility payload for accounting dashboard', async () => {
  const response = await request(buildApp())
    .get('/seller/finance')
    .set('Authorization', `Bearer ${accessToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.summary, {
    pendingPayoutMinor: 10000,
    frozenMinor: 5000,
    paidOutMinor: 7000,
    refundsAndHoldsMinor: 3000,
    availableToPayoutMinor: 10000
  });

  assert.deepEqual(response.body.data.nextPayout, {
    availableAt: null,
    ordersCount: 2,
    amountMinor: 15000
  });

  assert.equal(response.body.data.queue.length, 2);
  assert.equal(response.body.data.holds.length, 2);
  assert.equal(response.body.data.history.length, 1);
});

test('GET /seller/finance returns valid empty structure when seller has no finance data', async () => {
  (prisma.order.findMany as unknown as (args: any) => Promise<any>) = async (args: any) => {
    lastOrderFindManyArgs = args;
    return [];
  };
  (prisma as any).sellerPayoutMethod.findMany = async () => [];

  const response = await request(buildApp())
    .get('/seller/finance')
    .set('Authorization', `Bearer ${accessToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, {
    summary: {
      pendingPayoutMinor: 0,
      frozenMinor: 0,
      paidOutMinor: 0,
      refundsAndHoldsMinor: 0,
      availableToPayoutMinor: 0
    },
    nextPayout: {
      availableAt: null,
      ordersCount: 0,
      amountMinor: 0
    },
    queue: [],
    holds: [],
    history: []
  });
});

test('GET /seller/payout-methods returns widget config for Safe Deal', async () => {
  process.env.YOOKASSA_SHOP_ID = 'shop-123';

  const response = await request(buildApp())
    .get('/seller/payout-methods')
    .set('Authorization', `Bearer ${accessToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data.methods, [{ provider: 'yookassa', type: 'bank_card', active: true }]);
  assert.equal(response.body.data.widgetConfig.enabled, true);
  assert.equal(response.body.data.widgetConfig.type, 'safedeal');
  assert.equal(response.body.data.widgetConfig.accountId, 'shop-123');
  assert.equal(response.body.data.widgetConfig.hasSavedCard, true);
  assert.equal(response.body.data.widgetConfig.card.last4, '2537');
});

test('GET /seller/payout-methods returns disabled widget reason when Safe Deal is not configured', async () => {
  process.env.YOOKASSA_SHOP_ID = '';

  const response = await request(buildApp())
    .get('/seller/payout-methods')
    .set('Authorization', `Bearer ${accessToken}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.data.widgetConfig.enabled, false);
  assert.equal(response.body.data.widgetConfig.accountId, null);
  assert.equal(response.body.data.widgetConfig.reason, 'YOOKASSA_SHOP_ID is not configured');
});

test('GET /seller/payout-methods enables Safe Deal widget with shop credentials even without explicit flag', async () => {
  process.env.YOOKASSA_SHOP_ID = '1316134';

  const response = await request(buildApp())
    .get('/seller/payout-methods')
    .set('Authorization', `Bearer ${accessToken}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.data.widgetConfig.enabled, true);
  assert.equal(response.body.data.widgetConfig.accountId, '1316134');
  assert.equal(response.body.data.widgetConfig.type, 'safedeal');
});

test('POST /seller/payout-methods/yookassa/card accepts snake_case payload from widget', async () => {
  const response = await request(buildApp())
    .post('/seller/payout-methods/yookassa/card')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      payout_token: 'pt_test_123',
      first_6: '220220',
      last_4: '2537',
      issuer_name: 'Sberbank Of Russia',
      issuer_country: 'RU',
      card_type: 'Mir'
    });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.saved, true);
  assert.equal(response.body.data.card.last4, '2537');
  assert.equal(response.body.data.card.first6, '220220');
  assert.equal(response.body.data.card.cardType, 'Mir');
  assert.equal(response.body.data.card.issuerName, 'Sberbank Of Russia');
  assert.equal(response.body.data.card.issuerCountry, 'RU');
});

test('POST /seller/payouts creates seller payout from saved card', async () => {
  (prisma.order.findFirst as any) = async () => ({ id: 'order-1', publicNumber: 'PF-101', yookassaDealId: 'deal-1' });
  (prisma.order.findMany as any) = async () => ([{ id: 'order-1', sellerNetAmountKopecks: 100000, total: 100000 }]);
  (prisma as any).sellerPayout.findMany = async () => [];

  const response = await request(buildApp())
    .post('/seller/payouts')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ amount: '1000.00', description: 'Выплата продавцу' });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.status, 'pending');
  assert.equal(response.body.data.amount.value, '1000.00');
});
