import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { cdekWebhookService } from './cdekWebhookService';
import { createShipmentCdek } from './shipmentService';
import { buildShippingSnapshot } from './shippingPackageService';

const originals = {
  order: prisma.order.findUnique, shipment: prisma.orderShipment.findUnique,
  payment: prisma.payment.findFirst, transaction: prisma.$transaction,
  create: cdekService.createOrderFromMarketplaceOrder, get: cdekService.getOrderByUuid
};

const setup = (getOrder: () => Promise<any>) => {
  const order: any = {
    id: 'order-readback', status: 'PRINTING', paymentStatus: 'PAID', paidAt: new Date(), isPacked: true,
    packedWeightGrams: 400, packedLengthCm: 15, packedWidthCm: 15, packedHeightCm: 15,
    packedDeliveryAmountKopecks: 20475, packedQuoteCalculatedAt: new Date(),
    sellerNetAmountKopecks: 150000, readyForShipmentAt: null, cdekOrderId: null,
    buyerPickupPvzId: 'MSK123', sellerDropoffPvzId: 'SPB123',
    buyerPickupPvzMeta: { provider: 'CDEK' }, sellerDropoffPvzMeta: { provider: 'CDEK' },
    shippingSnapshot: buildShippingSnapshot([{ productId: 'product-1', quantity: 1,
      weightGrossG: 300, dxCm: 10, dyCm: 10, dzCm: 10 }]),
    recipientName: 'Buyer', recipientPhone: '+79997654321', buyer: {}, contact: null,
    items: [{ id: 'item-1', productId: 'product-1', quantity: 1, priceAtPurchase: 150000,
      product: { id: 'product-1', sellerId: 'seller-1', title: 'Part', sku: 'PF-000001',
        seller: { fullName: 'Seller', phone: '+79991234567',
          sellerProfile: { contactName: 'Contact', contactPhone: '+79991234567' } } }, variant: null }]
  };
  let shipment: any = null;
  let createCalls = 0;
  let getCalls = 0;
  (prisma.order.findUnique as any) = async () => order;
  (prisma.orderShipment.findUnique as any) = async () => shipment;
  (prisma.payment.findFirst as any) = async () => ({ status: 'SUCCEEDED' });
  (prisma.$transaction as any) = async (callback: any) => callback({
    $queryRaw: async () => [{ id: order.id }],
    order: { findUnique: async () => ({ ...order, shipment }),
      update: async ({ data }: any) => { Object.assign(order, data); return order; } },
    orderShipment: { upsert: async ({ create }: any) => {
      shipment = { id: 'shipment-readback', ...create }; return shipment;
    } },
    orderShipmentStatusHistory: { create: async () => ({}) }
  });
  (cdekService.createOrderFromMarketplaceOrder as any) = async () => {
    createCalls++; return { cdekOrderId: 'cdek-created', cdekRequestUuid: 'request-created',
      trackingNumber: null, state: 'ACCEPTED' };
  };
  (cdekService.getOrderByUuid as any) = async () => { getCalls++; return getOrder(); };
  return { order, get shipment() { return shipment; }, get createCalls() { return createCalls; },
    get getCalls() { return getCalls; } };
};

const missing = () => ({ response: { status: 400,
  data: { requests: [{ errors: [{ code: 'v2_entity_not_found' }] }] } } });

test('202 plus four missing readbacks preserves local UUID and prevents a second POST', async () => {
  const h = setup(async () => { throw missing(); });
  const first = await createShipmentCdek('order-readback', 'seller-1', { readbackSleep: async () => {} });
  assert.equal(first.cdek.cdekOrderId, 'cdek-created');
  assert.equal(h.shipment.statusRaw.readback.status, 'PENDING');
  assert.equal(h.shipment.statusRaw.readback.attempts, 4);
  assert.equal(h.order.cdekOrderId, 'cdek-created');
  await createShipmentCdek('order-readback', 'seller-1', { readbackSleep: async () => {} });
  assert.equal(h.createCalls, 1);
  assert.equal(h.getCalls, 4);
});

test('202 plus two missing readbacks then success verifies with one POST', async () => {
  let lookups = 0;
  const originalApply = cdekWebhookService.applyVerifiedCdekStatus;
  (cdekWebhookService.applyVerifiedCdekStatus as any) = async () => ({ accepted: true });
  try {
    const h = setup(async () => {
      lookups++;
      if (lookups < 3) throw missing();
      return { cdekOrderId: 'cdek-created', status: 'CREATED', trackingNumber: '',
        requestUuid: 'request-created', relatedEntities: { waybillUrl: null, barcodeUrls: [] }, raw: {} };
    });
    await createShipmentCdek('order-readback', 'seller-1', { readbackSleep: async () => {} });
    assert.equal(h.shipment.statusRaw.readback.status, 'VERIFIED');
    assert.equal(h.shipment.statusRaw.readback.attempts, 3);
    assert.equal(h.createCalls, 1);
    assert.equal(h.getCalls, 3);
  } finally {
    (cdekWebhookService.applyVerifiedCdekStatus as any) = originalApply;
  }
});

test('202 plus readback 401 preserves local UUID and marks AUTH_FAILED', async () => {
  const h = setup(async () => { throw { response: { status: 401 } }; });
  await createShipmentCdek('order-readback', 'seller-1', { readbackSleep: async () => {} });
  assert.equal(h.shipment.statusRaw.readback.status, 'AUTH_FAILED');
  assert.equal(h.order.cdekOrderId, 'cdek-created');
  assert.equal(h.createCalls, 1);
  assert.equal(h.getCalls, 1);
});

test.after(() => {
  (prisma.order.findUnique as any) = originals.order;
  (prisma.orderShipment.findUnique as any) = originals.shipment;
  (prisma.payment.findFirst as any) = originals.payment;
  (prisma.$transaction as any) = originals.transaction;
  (cdekService.createOrderFromMarketplaceOrder as any) = originals.create;
  (cdekService.getOrderByUuid as any) = originals.get;
});
