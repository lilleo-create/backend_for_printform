import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { payoutService } from './payoutService';

test('delivered creates payout once and second call is no-op', async () => {
  let created = 0;
  let payoutLookupCount = 0;

  (prisma.order.findUnique as any) = async () => ({
    id: 'order-1',
    status: 'DELIVERED',
    paymentStatus: 'PAID',
    payoutStatus: payoutLookupCount === 0 ? 'HOLD' : 'RELEASED',
    fundsReleasedAt: payoutLookupCount === 0 ? null : new Date('2026-04-02T12:00:00.000Z'),
    total: 100,
    grossAmountKopecks: 100,
    platformFeeKopecks: 10,
    acquiringFeeKopecks: 3,
    currency: 'RUB'
  });
  (prisma.orderItem.findFirst as any) = async () => ({ product: { sellerId: 'seller-1' } });
  (prisma.payout.findUnique as any) = async () => {
    payoutLookupCount += 1;
    return payoutLookupCount > 1 ? { id: 'po-1' } : null;
  };
  (prisma.payout.create as any) = async () => {
    created += 1;
    return {};
  };
  (prisma.order.update as any) = async () => ({});
  (prisma as any).sellerBalanceLedgerEntry = { upsert: async () => ({}) };

  await payoutService.releaseForDeliveredOrder('order-1');
  await payoutService.releaseForDeliveredOrder('order-1');

  assert.equal(created, 1);
});

test('cancelled order sets BLOCKED and does not create payout', async () => {
  let created = 0;
  let blocked = false;

  (prisma.order.findUnique as any) = async () => ({
    id: 'order-2',
    status: 'RETURNED',
    paymentStatus: 'PAID',
    payoutStatus: 'HOLD',
    total: 200,
    grossAmountKopecks: 200,
    platformFeeKopecks: 20,
    acquiringFeeKopecks: 5,
    currency: 'RUB'
  });
  (prisma.payout.findUnique as any) = async () => null;
  (prisma.payout.create as any) = async () => {
    created += 1;
    return {};
  };
  (prisma.order.update as any) = async ({ data }: any) => {
    if (data.payoutStatus === 'BLOCKED') blocked = true;
    return {};
  };
  (prisma as any).sellerBalanceLedgerEntry = { upsert: async () => ({}) };

  await payoutService.releaseForDeliveredOrder('order-2');

  assert.equal(created, 0);
  assert.equal(blocked, true);
});
