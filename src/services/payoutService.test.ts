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
    payoutStatus: payoutLookupCount === 0 ? 'HOLD' : 'RELEASED',
    total: 100,
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
    payoutStatus: 'HOLD',
    total: 200,
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

  await payoutService.releaseForDeliveredOrder('order-2');

  assert.equal(created, 0);
  assert.equal(blocked, true);
});
