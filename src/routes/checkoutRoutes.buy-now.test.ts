import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { checkoutRoutes } from './checkoutRoutes';
import { prisma } from '../lib/prisma';

type Session = { id: string; scopeKey: string; source: 'CART' | 'BUY_NOW' };
type Item = { id: string; sessionId: string; productId: string; variantId: string | null; quantity: number };

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/checkout', checkoutRoutes);
  return app;
};

const originalQueryRaw = prisma.$queryRawUnsafe;
const originalExecuteRaw = prisma.$executeRawUnsafe;
const originalTransaction = prisma.$transaction;
const originalProductFindMany = prisma.product.findMany;
const originalUserFindUnique = prisma.user.findUnique;
const originalContactFindFirst = prisma.contact.findFirst;
const originalAddressFindFirst = prisma.address.findFirst;

test.afterEach(() => {
  (prisma.$queryRawUnsafe as any) = originalQueryRaw;
  (prisma.$executeRawUnsafe as any) = originalExecuteRaw;
  (prisma.$transaction as any) = originalTransaction;
  (prisma.product.findMany as any) = originalProductFindMany;
  (prisma.user.findUnique as any) = originalUserFindUnique;
  (prisma.contact.findFirst as any) = originalContactFindFirst;
  (prisma.address.findFirst as any) = originalAddressFindFirst;
});

test('buy-now replaces previous buy-now items and does not affect cart', async () => {
  const sessions: Session[] = [];
  const items: Item[] = [];

  const findSession = (scopeKey: string, source: 'CART' | 'BUY_NOW') =>
    sessions.find((session) => session.scopeKey === scopeKey && session.source === source) ?? null;

  const queryRaw = async (sql: string, ...params: any[]) => {
    if (sql.includes('SELECT id FROM checkout_sessions')) {
      const [scopeKey, source] = params;
      const session = findSession(scopeKey, source);
      return session ? [{ id: session.id }] : [];
    }

    if (sql.includes('SELECT product_id, variant_id, quantity')) {
      const [sessionId] = params;
      return items
        .filter((item) => item.sessionId === sessionId)
        .map((item) => ({ product_id: item.productId, variant_id: item.variantId, quantity: item.quantity }));
    }

    if (sql.includes('SELECT id, quantity') && sql.includes('FROM checkout_session_items')) {
      const [sessionId, productId, variantId] = params;
      const found = items.find((item) => item.sessionId === sessionId && item.productId === productId && (item.variantId ?? '') === (variantId ?? ''));
      return found ? [{ id: found.id, quantity: found.quantity }] : [];
    }

    if (sql.includes('SELECT * FROM user_checkout_preferences')) return [];
    if (sql.includes('FROM user_saved_cards')) return [];

    return [];
  };

  const execRaw = async (sql: string, ...params: any[]) => {
    if (sql.includes('INSERT INTO checkout_sessions')) {
      const [sessionId, scopeKey, source] = params;
      const existing = findSession(scopeKey, source);
      if (!existing) {
        sessions.push({ id: sessionId, scopeKey, source });
      }
      return 1;
    }

    if (sql.includes('DELETE FROM checkout_session_items WHERE session_id = $1') && !sql.includes('product_id')) {
      const [sessionId] = params;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        if (items[i].sessionId === sessionId) {
          items.splice(i, 1);
        }
      }
      return 1;
    }

    if (sql.includes('INSERT INTO checkout_session_items')) {
      const [id, sessionId, productId, variantId, quantity] = params;
      items.push({ id, sessionId, productId, variantId, quantity });
      return 1;
    }

    if (sql.includes('UPDATE checkout_session_items SET quantity')) {
      const [id, quantity] = params;
      const item = items.find((value) => value.id === id);
      if (item) item.quantity = quantity;
      return 1;
    }

    if (sql.includes('DELETE FROM checkout_session_items') && sql.includes('product_id')) {
      const [sessionId, productId, variantId] = params;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const current = items[i];
        if (current.sessionId === sessionId && current.productId === productId && (current.variantId ?? '') === (variantId ?? '')) {
          items.splice(i, 1);
        }
      }
      return 1;
    }

    return 1;
  };

  (prisma.$queryRawUnsafe as any) = queryRaw;
  (prisma.$executeRawUnsafe as any) = execRaw;
  (prisma.$transaction as any) = async (callback: any) => callback({ $executeRawUnsafe: execRaw, $queryRawUnsafe: queryRaw });
  (prisma.product.findMany as any) = async ({ where }: any) => {
    const ids = where.id?.in ?? [];
    return ids.map((id: string) => ({
      id,
      title: `Title ${id}`,
      price: 100,
      image: '/image.png',
      descriptionShort: 'desc',
      sku: 'sku',
      sellerId: 'seller-1',
      weightGrossG: null,
      dxCm: null,
      dyCm: null,
      dzCm: null
    }));
  };

  (prisma.user.findUnique as any) = async () => null;
  (prisma.contact.findFirst as any) = async () => null;
  (prisma.address.findFirst as any) = async () => null;

  const app = buildApp();

  await request(app)
    .post('/checkout/cart/items')
    .set('x-checkout-session-token', 'guest-1')
    .send({ productId: 'C', quantity: 1 })
    .expect(200);

  await request(app)
    .post('/checkout/buy-now')
    .set('x-checkout-session-token', 'guest-1')
    .send({ items: [{ productId: 'A', quantity: 1 }] })
    .expect(200);

  await request(app)
    .post('/checkout/buy-now')
    .set('x-checkout-session-token', 'guest-1')
    .send({ items: [{ productId: 'B', quantity: 1 }] })
    .expect(200);

  const buyNow = await request(app)
    .get('/checkout/buy-now')
    .set('x-checkout-session-token', 'guest-1')
    .expect(200);

  const cart = await request(app)
    .get('/checkout?source=CART')
    .set('x-checkout-session-token', 'guest-1')
    .expect(200);

  assert.deepEqual(buyNow.body.cartItems.map((item: any) => item.productId), ['B']);
  assert.deepEqual(cart.body.cartItems.map((item: any) => item.productId), ['C']);
});
