import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { createShipmentCdek } from './shipmentService';
import { buildShippingSnapshot } from './shippingPackageService';

test('CDEK shipment uses the paid order snapshot after product measurements change', async () => {
  const originalOrder = prisma.order.findUnique;
  const originalPayment = prisma.payment.findFirst;
  const originalShipment = prisma.orderShipment.findUnique;
  const originalTransaction = prisma.$transaction;
  const originalCreate = cdekService.createOrderFromMarketplaceOrder;
  const originalGet = cdekService.getOrderByUuid;
  const snapshot = buildShippingSnapshot([
    { productId: 'a', quantity: 3, weightGrossG: 350, dxCm: 19, dyCm: 12.5, dzCm: 9.5 }
  ]);
  let sent: any;
  try {
    (prisma.order.findUnique as any) = async () => ({
      id: 'order-1', paidAt: new Date(), isPacked: true,
      buyerPickupPvzId: 'MSK123', sellerDropoffPvzId: 'SPB123',
      buyerPickupPvzMeta: { provider: 'CDEK' },
      shippingSnapshot: snapshot,
      recipientName: 'Test', recipientPhone: '+79990000000',
      items: [{ id: 'item-1', productId: 'a', quantity: 3, priceAtPurchase: 10000,
        product: { id: 'a', sellerId: 'seller', title: 'Part', sku: 'A',
          weightGrossG: 1, dxCm: 1, dyCm: 1, dzCm: 1 }, variant: null }],
      buyer: {}, contact: null
    });
    (prisma.payment.findFirst as any) = async () => ({ status: 'SUCCEEDED' });
    (prisma.orderShipment.findUnique as any) = async () => null;
    (cdekService.createOrderFromMarketplaceOrder as any) = async (payload: any) => {
      sent = payload;
      return { cdekOrderId: 'uuid-1', trackingNumber: null, state: 'ACCEPTED' };
    };
    (cdekService.getOrderByUuid as any) = async () => { throw new Error('sync unavailable'); };
    (prisma.$transaction as any) = async (callback: any) => callback({
      orderShipment: { upsert: async () => ({ id: 'shipment-1' }) },
      order: { update: async () => ({}) },
      orderShipmentStatusHistory: { create: async () => ({}) }
    });
    await createShipmentCdek('order-1', 'seller');
    assert.deepEqual({
      weightGrams: sent.weightGrams, lengthCm: sent.lengthCm,
      widthCm: sent.widthCm, heightCm: sent.heightCm
    }, { weightGrams: 1050, lengthCm: 19, widthCm: 13, heightCm: 29 });
    assert.equal(sent.items[0].weight, 350);
  } finally {
    (prisma.order.findUnique as any) = originalOrder;
    (prisma.payment.findFirst as any) = originalPayment;
    (prisma.orderShipment.findUnique as any) = originalShipment;
    (prisma.$transaction as any) = originalTransaction;
    (cdekService.createOrderFromMarketplaceOrder as any) = originalCreate;
    (cdekService.getOrderByUuid as any) = originalGet;
  }
});
