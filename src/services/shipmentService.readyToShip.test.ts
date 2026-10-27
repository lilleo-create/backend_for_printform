import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { markReadyToShipCdek } from './shipmentService';
import { buildShippingSnapshot } from './shippingPackageService';

const originals = {
  orderFind: prisma.order.findUnique,
  shipmentFind: prisma.orderShipment.findUnique,
  transaction: prisma.$transaction,
  getOrder: cdekService.getOrderByUuid,
  createOrder: cdekService.createOrderFromMarketplaceOrder,
  deleteOrder: cdekService.deleteOrder
};

const setup = () => {
  const shipment: any = { id: 'shipment-1', orderId: 'order-1', status: 'READY_TO_SHIP' };
  const order: any = {
    id: 'order-1', status: 'PRINTING', paymentStatus: 'PAID', paidAt: new Date(),
    isPacked: true, readyForShipmentAt: null, cdekOrderId: 'cdek-uuid',
    cdekStatus: 'ACCEPTED', trackingNumber: '123', buyerPickupPvzId: 'MSK123',
    sellerDropoffPvzId: 'SPB123', buyerPickupPvzMeta: { provider: 'CDEK' },
    sellerDropoffPvzMeta: { provider: 'CDEK' },
    shippingSnapshot: buildShippingSnapshot([
      { productId: 'product-1', quantity: 1, weightGrossG: 300, dxCm: 10, dyCm: 10, dzCm: 10 }
    ]),
    recipientName: 'Test', recipientPhone: '+79990000000',
    items: [{ id: 'item-1', productId: 'product-1', quantity: 1, priceAtPurchase: 1000,
      product: { id: 'product-1', sellerId: 'seller-1', title: 'Item', sku: 'SKU' }, variant: null }],
    buyer: {}, contact: null
  };
  let writes = 0;
  (prisma.order.findUnique as any) = async () => order;
  (prisma.orderShipment.findUnique as any) = async () => shipment;
  (prisma.$transaction as any) = async (callback: any) => callback({
    $queryRaw: async () => [{ id: order.id }],
    order: {
      findUnique: async () => ({ ...order, shipment }),
      update: async ({ data }: any) => { writes++; Object.assign(order, data); return order; }
    },
    orderShipment: {
      update: async ({ data }: any) => { writes++; Object.assign(shipment, data); return shipment; }
    },
    orderShipmentStatusHistory: { create: async () => { writes++; return {}; } }
  });
  (cdekService.getOrderByUuid as any) = async () => { throw new Error('SYNC_UNAVAILABLE'); };
  return { order, shipment, get writes() { return writes; } };
};

test('ready-to-ship requires paid order and packing', async () => {
  const h = setup();
  h.order.paymentStatus = 'PENDING_PAYMENT';
  h.order.paidAt = null;
  await assert.rejects(markReadyToShipCdek('order-1', 'seller-1'), /ORDER_NOT_PAID/);
  h.order.paymentStatus = 'PAID';
  h.order.paidAt = new Date();
  h.order.isPacked = false;
  await assert.rejects(markReadyToShipCdek('order-1', 'seller-1'),
    (error: any) => error.code === 'FULFILLMENT_STEPS_INCOMPLETE');
  h.order.isPacked = true;
  h.order.status = 'PAID';
  await assert.rejects(markReadyToShipCdek('order-1', 'seller-1'),
    (error: any) => error.code === 'PRODUCTION_NOT_STARTED');
  assert.equal(h.writes, 0);
});

test('ready-to-ship creates preparation state once and repeated call is idempotent', async () => {
  const h = setup();
  const first = await markReadyToShipCdek('order-1', 'seller-1');
  assert.equal(first.shipment.id, 'shipment-1');
  assert.equal(h.order.status, 'READY_FOR_SHIPMENT');
  assert.ok(h.order.readyForShipmentAt);
  const writes = h.writes;
  const timestamp = h.order.readyForShipmentAt;
  const second = await markReadyToShipCdek('order-1', 'seller-1');
  assert.equal(second.shipment.id, 'shipment-1');
  assert.equal(h.writes, writes);
  assert.equal(h.order.readyForShipmentAt, timestamp);
});

test('ready-to-ship cannot reopen carrier or terminal order', async () => {
  const h = setup();
  for (const status of ['HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED', 'RETURNED', 'CANCELLED']) {
    h.order.status = status;
    await assert.rejects(markReadyToShipCdek('order-1', 'seller-1'), /SELLER_SHIPMENT_STATUS_LOCKED/);
  }
  assert.equal(h.writes, 0);
});

test('cancellation during CDEK creation cannot reopen order and cleans up external order', async () => {
  const h = setup();
  h.order.cdekOrderId = null;
  (prisma.orderShipment.findUnique as any) = async () => null;
  let deleted: string | null = null;
  (cdekService.createOrderFromMarketplaceOrder as any) = async () => {
    h.order.status = 'CANCELLED';
    return { cdekOrderId: 'new-cdek-uuid', trackingNumber: null, state: 'ACCEPTED' };
  };
  (cdekService.deleteOrder as any) = async (uuid: string) => { deleted = uuid; };
  await assert.rejects(markReadyToShipCdek('order-1', 'seller-1'),
    (error: any) => error.code === 'SELLER_SHIPMENT_STATUS_LOCKED');
  assert.equal(h.order.status, 'CANCELLED');
  assert.equal(h.writes, 0);
  assert.equal(deleted, 'new-cdek-uuid');
});

test.after(() => {
  (prisma.order.findUnique as any) = originals.orderFind;
  (prisma.orderShipment.findUnique as any) = originals.shipmentFind;
  (prisma.$transaction as any) = originals.transaction;
  (cdekService.getOrderByUuid as any) = originals.getOrder;
  (cdekService.createOrderFromMarketplaceOrder as any) = originals.createOrder;
  (cdekService.deleteOrder as any) = originals.deleteOrder;
});
