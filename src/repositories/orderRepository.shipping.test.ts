import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { orderRepository } from './orderRepository';
import { buildShippingSnapshot } from '../services/shippingPackageService';

test('seller-sponsored order keeps real CDEK quote without charging buyer', async () => {
  const originalTransaction = prisma.$transaction;
  const snapshot = buildShippingSnapshot([
    { productId: 'a', quantity: 3, weightGrossG: 350, dxCm: 19, dyCm: 12, dzCm: 9.5 }
  ]);
  let created: any;
  try {
    (prisma.$transaction as any) = async (callback: any) => callback({
      product: { findMany: async () => [{ id: 'a', price: 10000, currency: 'RUB' }] },
      orderPublicNumberCounter: { upsert: async () => ({ lastValue: 1 }) },
      order: { create: async ({ data }: any) => { created = data; return data; } }
    });
    await orderRepository.create({
      buyerId: 'buyer', items: [{ productId: 'a', quantity: 3 }],
      deliveryAmountKopecks: 27550,
      shippingSnapshot: snapshot
    });
    assert.equal(created.total, 30000);
    assert.equal(created.deliveryAmountKopecks, 27550);
    assert.equal(created.deliveryChargedToBuyerKopecks, 0);
    assert.deepEqual(created.shippingSnapshot, snapshot);
    assert.ok(created.deliveryCalculatedAt instanceof Date);
  } finally {
    (prisma.$transaction as any) = originalTransaction;
  }
});
