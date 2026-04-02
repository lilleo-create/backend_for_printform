import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { sellerPayoutService } from './sellerPayoutService';
import { yookassaService } from './yookassaService';

test('createPayoutMethod resets previous default method', async () => {
  let resetCalled = 0;
  let createdPayload: any = null;

  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      sellerPayoutMethod: {
        updateMany: async () => {
          resetCalled += 1;
        },
        create: async ({ data }: any) => {
          createdPayload = data;
          return { id: 'pm-1', ...data, createdAt: new Date(), updatedAt: new Date() };
        },
        findFirst: async () => ({ id: 'pm-1' }),
        update: async ({ data }: any) => ({ id: 'pm-1', ...data })
      }
    });

  const created = await sellerPayoutService.createPayoutMethod('seller-1', {
    provider: 'YOOKASSA',
    methodType: 'BANK_CARD',
    payoutToken: 'ptok_1',
    cardLast4: '2537',
    cardType: 'Mir',
    isDefault: true
  });

  assert.equal(resetCalled, 1);
  assert.equal(createdPayload.isDefault, true);
  assert.equal(createdPayload.maskedLabel, 'Mir •••• 2537');
  assert.equal(created.id, 'pm-1');
});

test('createPayoutForOrder supports payout token and yoomoney destination', async () => {
  const calls: any[] = [];
  let currentMethodType: 'BANK_CARD' | 'YOOMONEY' = 'BANK_CARD';

  (prisma.order.findFirst as any) = async () => ({
    id: 'order-1',
    publicNumber: 'PF-1',
    paymentStatus: 'PAID',
    yookassaDealId: 'deal-1',
    currency: 'RUB',
    total: 1000,
    sellerNetAmountKopecks: 900,
    sellerPayouts: []
  });
  (prisma.order.update as any) = async () => ({});
  (prisma as any).sellerPayoutMethod = {
    findFirst: async () =>
      currentMethodType === 'BANK_CARD'
        ? { id: 'pm-card', methodType: 'BANK_CARD', payoutToken: 'pt_1', status: 'ACTIVE' }
        : { id: 'pm-yoomoney', methodType: 'YOOMONEY', yoomoneyAccountNumber: '4100111222333', status: 'ACTIVE' },
    update: async () => ({})
  };
  (prisma as any).sellerPayout = {
    create: async ({ data }: any) => ({ id: 'payout-1', ...data })
  };
  (yookassaService.createPayoutInDeal as any) = async (payload: any) => {
    calls.push(payload);
    return { id: `ext-${calls.length}`, status: 'pending' };
  };

  await sellerPayoutService.createPayoutForOrder('seller-1', 'order-1');
  currentMethodType = 'YOOMONEY';
  await sellerPayoutService.createPayoutForOrder('seller-1', 'order-1');

  assert.equal(calls[0].payoutToken, 'pt_1');
  assert.equal(calls[0].payoutDestinationData, undefined);
  assert.equal(calls[1].payoutToken, undefined);
  assert.deepEqual(calls[1].payoutDestinationData, { type: 'yoo_money', account_number: '4100111222333' });
});

test('buildFinanceView excludes HOLD from adjustments and builds payout history from seller payouts', async () => {
  (prisma.order.findMany as any) = async () => ([
    {
      id: 'order-hold',
      publicNumber: 'PF-11',
      total: 5000,
      grossAmountKopecks: 5000,
      platformFeeKopecks: 500,
      sellerNetAmountKopecks: 4500,
      currency: 'RUB',
      payoutStatus: 'HOLD',
      paymentStatus: 'PAID',
      status: 'PAID',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      paidAt: new Date('2026-03-01T01:00:00.000Z'),
      refunds: [],
      sellerPayouts: []
    },
    {
      id: 'order-paid',
      publicNumber: 'PF-12',
      total: 9000,
      grossAmountKopecks: 9000,
      platformFeeKopecks: 1000,
      sellerNetAmountKopecks: 8000,
      currency: 'RUB',
      payoutStatus: 'PAID_OUT',
      paymentStatus: 'PAID',
      status: 'DELIVERED',
      createdAt: new Date('2026-03-02T00:00:00.000Z'),
      paidAt: new Date('2026-03-02T01:00:00.000Z'),
      refunds: [],
      sellerPayouts: [
        {
          id: 'sp-1',
          status: 'SUCCEEDED',
          amountKopecks: 8000,
          createdAt: new Date('2026-03-04T00:00:00.000Z'),
          succeededAt: new Date('2026-03-04T01:00:00.000Z'),
          payoutMethod: { methodType: 'BANK_CARD', maskedLabel: 'Mir •••• 2537' }
        }
      ]
    }
  ]);
  (prisma as any).sellerPayoutMethod = { findMany: async () => [] };

  const data = await sellerPayoutService.buildFinanceView('seller-1');

  assert.equal(data.adjustments.length, 0);
  assert.equal(data.summary.frozenKopecks, 4500);
  assert.equal(data.payoutHistory.length, 1);
  assert.equal(data.payoutHistory[0].payoutId, 'sp-1');
});

test('getYookassaWidgetConfig returns account id and masked card data', async () => {
  process.env.YOOKASSA_SHOP_ID = 'shop-widget-1';
  (prisma as any).sellerPayoutMethod = {
    findFirst: async () => ({
      cardType: 'Mir',
      cardFirst6: '220220',
      cardLast4: '2537',
      cardIssuerCountry: 'RU',
      cardIssuerName: 'Sberbank',
      updatedAt: new Date('2026-03-30T10:00:00.000Z')
    })
  };

  const data = await sellerPayoutService.getYookassaWidgetConfig('seller-1');
  assert.equal(data.enabled, true);
  assert.equal(data.accountId, 'shop-widget-1');
  assert.equal(data.type, 'safedeal');
  assert.equal(data.hasSavedCard, true);
  assert.equal(data.card?.last4, '2537');
});

test('saveYookassaCardFromWidget upserts bank card token', async () => {
  const calls: string[] = [];
  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      sellerPayoutMethod: {
        findFirst: async () => ({ id: 'pm-1' }),
        updateMany: async () => calls.push('updateMany'),
        update: async ({ data }: any) => ({ id: 'pm-1', ...data }),
        create: async ({ data }: any) => ({ id: 'pm-new', ...data })
      }
    });

  const result = await sellerPayoutService.saveYookassaCardFromWidget('seller-1', {
    payoutToken: 'pt_abc',
    first6: '220220',
    last4: '2537',
    cardType: 'Mir',
    issuerCountry: 'RU',
    issuerName: 'Sberbank'
  });

  assert.deepEqual(calls, ['updateMany', 'updateMany']);
  assert.equal(result.last4, '2537');
});

test('createSellerPayout validates balance and creates YooKassa payout', async () => {
  (prisma as any).sellerPayoutMethod = {
    findFirst: async () => ({ id: 'pm-card', payoutToken: 'pt_1', status: 'ACTIVE' })
  };
  (prisma.order.findMany as any) = async () => ([
    { id: 'order-1', sellerNetAmountKopecks: 50000, total: 50000 }
  ]);
  (prisma.order.findFirst as any) = async () => ({
    id: 'order-1',
    publicNumber: 'PF-1',
    yookassaDealId: 'deal-1'
  });
  (prisma as any).sellerPayout = {
    findMany: async () => [],
    create: async ({ data }: any) => ({ id: 'payout-1', createdAt: new Date(), ...data })
  };
  (yookassaService.createPayoutInDeal as any) = async () => ({ id: 'ext-1', status: 'pending' });

  const payout = await sellerPayoutService.createSellerPayout('seller-1', { amount: '100.00', description: 'Тест' });
  assert.equal(payout.id, 'payout-1');
  assert.equal(payout.dealId, 'deal-1');
  assert.equal(payout.status, 'PENDING');
});

test('createSellerPayout rejects when amount is above available balance', async () => {
  (prisma as any).sellerPayoutMethod = {
    findFirst: async () => ({ id: 'pm-card', payoutToken: 'pt_1', status: 'ACTIVE' })
  };
  (prisma.order.findMany as any) = async () => ([
    { id: 'order-1', sellerNetAmountKopecks: 5000, total: 5000 }
  ]);
  (prisma as any).sellerPayout = {
    findMany: async () => []
  };

  await assert.rejects(
    () => sellerPayoutService.createSellerPayout('seller-1', { amount: '100.00' }),
    (error: any) => error?.code === 'INSUFFICIENT_AVAILABLE_BALANCE'
  );
});
