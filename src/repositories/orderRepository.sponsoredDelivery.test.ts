import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { orderRepository } from './orderRepository';

test('seller-sponsored CDEK quote is stored but buyer and Payment owe goods only', async () => {
  const original = prisma.$transaction;
  let created: any;
  try {
    (prisma.$transaction as any) = async (callback: any) => callback({
      product: { findMany: async () => [{ id: 'p1', price: 150000, currency: 'RUB' }] },
      productVariant: { findMany: async () => [] },
      orderPublicNumberCounter: { upsert: async () => ({ lastValue: 1 }) },
      order: { create: async ({ data }: any) => { created = data; return data; } }
    });
    await orderRepository.create({
      buyerId: 'buyer', paymentAttemptKey: 'attempt',
      items: [{ productId: 'p1', quantity: 1, expectedPriceKopecks: 150000 }],
      deliveryAmountKopecks: 20475,
      deliveryChargedToBuyerKopecks: 0
    });
    assert.equal(created.deliveryAmountKopecks, 20475);
    assert.equal(created.checkoutDeliveryEstimateKopecks, 20475);
    assert.equal(created.deliveryChargedToBuyerKopecks, 0);
    assert.equal(created.total, 150000);
  } finally {
    (prisma.$transaction as any) = original;
  }
});

test('backend DB price change rejects stale cart price before order creation', async () => {
  const original = prisma.$transaction;
  let created = false;
  try {
    (prisma.$transaction as any) = async (callback: any) => callback({
      product: { findMany: async () => [{ id: 'p1', price: 150000, currency: 'RUB' }] },
      productVariant: { findMany: async () => [] },
      orderPublicNumberCounter: { upsert: async () => ({ lastValue: 1 }) },
      order: { create: async () => { created = true; } }
    });
    await assert.rejects(orderRepository.create({
      buyerId: 'buyer', items: [{ productId: 'p1', quantity: 1, expectedPriceKopecks: 149900 }],
      deliveryAmountKopecks: 20475, deliveryChargedToBuyerKopecks: 0
    }), /PRODUCT_PRICE_CHANGED/);
    assert.equal(created, false);
  } finally {
    (prisma.$transaction as any) = original;
  }
});
