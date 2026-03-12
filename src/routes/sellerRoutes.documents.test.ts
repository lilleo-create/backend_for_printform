import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sellerRoutes } from './sellerRoutes';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { cdekService } from '../services/cdekService';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/seller', sellerRoutes);
  return app;
};

const tokenFor = (userId: string) => jwt.sign({ userId, role: 'SELLER', scope: 'access' }, env.jwtSecret);

const mockAuth = () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'SELLER' });
  (prisma.sellerProfile.findUnique as any) = async () => ({ id: 'sp-1' });
  (prisma.order.update as any) = async ({ where }: any) => ({ id: where?.id ?? 'order-own' });
  (prisma.orderShipment.update as any) = async ({ where, data }: any) => ({ id: where?.id ?? 'shipment-1', ...data });
  (prisma.payment.findFirst as any) = async () => ({ status: 'SUCCEEDED' });
};

const mockOrder = (orderId: string) => ({
  id: orderId,
  createdAt: new Date('2026-01-01T10:00:00.000Z'),
  total: 1500,
  currency: 'RUB',
  recipientName: 'Иван Иванов',
  recipientPhone: '+79990000000',
  recipientEmail: 'ivan@test.dev',
  packagesCount: 1,
  orderLabels: [{ packageNo: 1, code: 'PF-ABC-1' }],
  buyerPickupPvzMeta: { addressFull: 'ПВЗ покупателя' },
  sellerDropoffPvzMeta: { addressFull: 'ПВЗ продавца' },
  paidAt: new Date('2026-01-01T09:00:00.000Z'),
  cdekOrderId: 'cdek-uuid',
  shipment: { id: 'shipment-1', labelPrintRequestUuid: 'label-print-uuid', actPrintRequestUuid: 'act-print-uuid' },
  items: [{ quantity: 1, priceAtPurchase: 1500, product: { title: 'Товар' } }]
});

test('seller documents endpoints return application/pdf and 200 for own order', async () => {
  mockAuth();
  (cdekService.getOrderPrintStatus as any) = async () => ({ status: 'READY' });
  (cdekService.downloadOrderPrintPdf as any) = async () => Buffer.from('%PDF-ready%');
  (cdekService.getBarcodePrintTaskForLabel as any) = async () => ({ status: 'READY', statuses: [] });
  (cdekService.downloadBarcodePdf as any) = async () => Buffer.from('%PDF-ready%');
  (prisma.order.findFirst as any) = async ({ where }: any) => {
    if (where.id === 'order-own') return mockOrder('order-own');
    return null;
  };

  const app = buildApp();
  const auth = `Bearer ${tokenFor('seller-1')}`;

  const packing = await request(app).get('/seller/orders/order-own/documents/packing-slip.pdf').set('Authorization', auth);
  const labels = await request(app).get('/seller/orders/order-own/documents/label.pdf').set('Authorization', auth);
  const act = await request(app).get('/seller/orders/order-own/documents/handover-act.pdf').set('Authorization', auth);

  assert.equal(packing.status, 200);
  assert.equal(labels.status, 200);
  assert.equal(act.status, 200);
  assert.match(packing.headers['content-type'] ?? '', /application\/pdf/);
  assert.match(labels.headers['content-type'] ?? '', /application\/pdf/);
  assert.match(act.headers['content-type'] ?? '', /application\/pdf/);
});

test('seller can access documents only for own orders', async () => {
  mockAuth();
  (prisma.order.findFirst as any) = async ({ where }: any) => {
    if (where.id === 'order-own') return mockOrder('order-own');
    return null;
  };

  const app = buildApp();
  const auth = `Bearer ${tokenFor('seller-1')}`;

  const denied = await request(app)
    .get('/seller/orders/order-other/documents/packing-slip.pdf')
    .set('Authorization', auth);

  assert.equal(denied.status, 404);
});

test('seller label/act return NEED_READY_TO_SHIP when CDEK shipment is missing', async () => {
  mockAuth();
  (prisma.order.findFirst as any) = async ({ where }: any) => {
    if (where.id === 'order-own') {
      return { ...mockOrder('order-own'), cdekOrderId: null, shipment: null };
    }
    return null;
  };

  const app = buildApp();
  const auth = `Bearer ${tokenFor('seller-1')}`;

  const label = await request(app).get('/seller/orders/order-own/documents/label.pdf').set('Authorization', auth);
  const act = await request(app).get('/seller/orders/order-own/documents/handover-act.pdf').set('Authorization', auth);

  assert.equal(label.status, 409);
  assert.equal(act.status, 409);
  assert.equal(label.body?.error?.code, 'NEED_READY_TO_SHIP');
  assert.equal(act.body?.error?.code, 'NEED_READY_TO_SHIP');
});


test('handover act is downloaded from CDEK order print API', async () => {
  mockAuth();
  (cdekService.getOrderPrintStatus as any) = async () => ({ status: 'READY' });
  (cdekService.downloadOrderPrintPdf as any) = async () => Buffer.from('%PDF-1.4 mock-from-cdek%');
  (prisma.order.findFirst as any) = async ({ where }: any) => {
    if (where.id === 'order-own') return mockOrder('order-own');
    return null;
  };

  const app = buildApp();
  const auth = `Bearer ${tokenFor('seller-1')}`;

  const act = await request(app).get('/seller/orders/order-own/documents/handover-act.pdf').set('Authorization', auth);

  assert.equal(act.status, 200);
  assert.match(act.headers['content-type'] ?? '', /application\/pdf/);
  assert.equal(Number(act.headers['content-length']), Buffer.from('%PDF-1.4 mock-from-cdek%').length);
});


test('seller label route uses CDEK order print API when print task is ready', async () => {
  mockAuth();
  (cdekService.getBarcodePrintTaskForLabel as any) = async () => ({ status: 'READY', statuses: [] });
  (cdekService.downloadBarcodePdf as any) = async () => Buffer.from('%PDF-fallback-label%');
  (prisma.order.findFirst as any) = async ({ where }: any) => {
    if (where.id === 'order-own') return mockOrder('order-own');
    return null;
  };

  const app = buildApp();
  const auth = `Bearer ${tokenFor('seller-1')}`;

  const label = await request(app).get('/seller/orders/order-own/documents/label.pdf').set('Authorization', auth);

  assert.equal(label.status, 200);
  assert.match(label.headers['content-type'] ?? '', /application\/pdf/);
});

test('seller label route returns FORMS_NOT_READY when print task is processing', async () => {
  mockAuth();
  (cdekService.getBarcodePrintTaskForLabel as any) = async () => ({ status: 'PROCESSING', statuses: [] });
  (prisma.order.findFirst as any) = async ({ where }: any) => {
    if (where.id === 'order-own') return mockOrder('order-own');
    return null;
  };

  const app = buildApp();
  const auth = `Bearer ${tokenFor('seller-1')}`;

  const label = await request(app).get('/seller/orders/order-own/documents/label.pdf').set('Authorization', auth);

  assert.equal(label.status, 409);
  assert.equal(label.body?.error?.code, 'FORMS_NOT_READY');
});
