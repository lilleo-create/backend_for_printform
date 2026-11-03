import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { orderRepository } from './orderRepository';

test('checkout repository uses current product and variant price, and keeps buyer delivery free', async (t) => {
  const original = prisma.$transaction;
  let products: any[] = [{ id: 'product-a', sellerId: 'seller-a', price: 1500, currency: 'RUB' }];
  let variants: any[] = [{ id: 'variant-a', productId: 'product-a', priceDelta: 100 }];
  let sellerApproved = true;
  let contactOwner = 'buyer-a';
  let addressOwner = 'buyer-a';
  let created: any = null;
  (prisma.$transaction as any) = async (callback: any) => callback({
    product: { findMany: async () => products },
    productVariant: { findMany: async () => variants },
    sellerProfile: { findFirst: async () => sellerApproved ? { id: 'profile-a' } : null },
    contact: { findFirst: async ({ where }: any) => where.userId === contactOwner ? { id: where.id } : null },
    address: { findFirst: async ({ where }: any) => where.userId === addressOwner ? { id: where.id } : null },
    orderPublicNumberCounter: { upsert: async () => ({ lastValue: 99 }) },
    order: { create: async ({ data }: any) => { created = data; return data; } }
  });
  const create = (overrides: Record<string, unknown> = {}) => orderRepository.create({
    buyerId: 'buyer-a', contactId: 'contact-a', shippingAddressId: 'address-a',
    items: [{ productId: 'product-a', variantId: 'variant-a', quantity: 2 }],
    deliveryAmountKopecks: 20475, deliveryChargedToBuyerKopecks: 0,
    ...overrides
  } as any);
  try {
    await t.test('valid checkout and tampered client totals cannot affect server total', async () => {
      await create({ total: 1, sellerId: 'attacker', price: 1 });
      assert.equal(created.total, 3200);
      assert.equal(created.deliveryChargedToBuyerKopecks, 0);
      assert.equal(created.items.create[0].priceAtPurchase, 1600);
    });
    await t.test('wrong or nonexistent variant is rejected before order creation', async () => {
      created = null;
      variants = [{ id: 'variant-a', productId: 'product-b', priceDelta: -1400 }];
      await assert.rejects(create(), /VARIANT_INVALID/);
      variants = [];
      await assert.rejects(create(), /VARIANT_INVALID/);
      assert.equal(created, null);
      variants = [{ id: 'variant-a', productId: 'product-a', priceDelta: 100 }];
    });
    await t.test('foreign contact and address cannot be attached to an order', async () => {
      contactOwner = 'buyer-b';
      await assert.rejects(create(), /CONTACT_NOT_FOUND/);
      contactOwner = 'buyer-a';
      addressOwner = 'buyer-b';
      await assert.rejects(create(), /SHIPPING_ADDRESS_NOT_FOUND/);
      addressOwner = 'buyer-a';
    });
    await t.test('legacy PVZ address sentinel remains compatible', async () => {
      await create({ shippingAddressId: 'cdek_pvz' });
      assert.equal(created.shippingAddressId, undefined);
    });
    await t.test('deleted, unapproved, or seller-ineligible products are unavailable', async () => {
      products = [];
      await assert.rejects(create(), /PRODUCT_NOT_FOUND/);
      products = [{ id: 'product-a', sellerId: 'seller-a', price: 1500, currency: 'RUB' }];
      sellerApproved = false;
      await assert.rejects(create(), /SELLER_NOT_AVAILABLE/);
      sellerApproved = true;
    });
    await t.test('stale expected price is rejected while omitted price still uses DB', async () => {
      await assert.rejects(create({ items: [{ productId: 'product-a', variantId: 'variant-a', quantity: 1, expectedPriceKopecks: 1 }] }), /PRODUCT_PRICE_CHANGED/);
      await create();
      assert.equal(created.total, 3200);
    });
    await t.test('invalid quantities and repeated identical lines are rejected', async () => {
      for (const quantity of [0, -1, 0.5, 1000]) {
        await assert.rejects(create({ items: [{ productId: 'product-a', quantity }] }), /QUANTITY_INVALID/);
      }
      await assert.rejects(create({ items: [
        { productId: 'product-a', variantId: 'variant-a', quantity: 1 },
        { productId: 'product-a', variantId: 'variant-a', quantity: 2 }
      ] }), /DUPLICATE_ORDER_ITEM/);
    });
  } finally { (prisma.$transaction as any) = original; }
});
