import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { buildShippingSnapshot } from './shippingPackageService';
import { orderPackingService } from './orderPackingService';

const original = {
  orderFind: prisma.order.findFirst,
  shipmentFind: prisma.orderShipment.findUnique,
  transaction: prisma.$transaction,
  calculate: cdekService.calculateDelivery
};

const parcel = { weightGrams: 520, lengthCm: 21.5, widthCm: 14.2, heightCm: 11.1 };
const makeOrder = () => ({
  id: 'order-1', status: 'PRINTING', paymentStatus: 'PAID', paidAt: new Date(), isPacked: false,
  readyForShipmentAt: null, cdekOrderId: null, sellerNetAmountKopecks: 149900,
  total: 149900, deliveryChargedToBuyerKopecks: 0,
  sellerDropoffPvzId: 'MSK424', buyerPickupPvzId: 'MSK541',
  sellerDropoffPvzMeta: { provider: 'CDEK', cityCode: 44 },
  buyerPickupPvzMeta: { provider: 'CDEK', cityCode: 44 },
  shippingSnapshot: buildShippingSnapshot([
    { productId: 'product-1', quantity: 1, weightGrossG: 350, dxCm: 19, dyCm: 12, dzCm: 9.5 }
  ]),
  items: [{ product: { sellerId: 'seller-1' } }]
});

test('packing quote uses actual parcel, confirmation stores cost without changing buyer total', async () => {
  const order: any = makeOrder();
  let updated: any;
  let sent: any;
  try {
    (prisma.order.findFirst as any) = async () => order;
    (prisma.orderShipment.findUnique as any) = async () => null;
    (cdekService.calculateDelivery as any) = async (input: any) => {
      sent = input;
      return { totalSum: 247, deliverySum: 247, deliveryDaysMin: 2, deliveryDaysMax: 4 };
    };
    (prisma.$transaction as any) = async (callback: any) => callback({
      $queryRaw: async () => [{ id: order.id }],
      order: {
        findUnique: async () => order,
        update: async ({ data }: any) => { updated = data; Object.assign(order, data); return order; }
      },
      orderShipment: { findUnique: async () => null }
    });
    const quote = await orderPackingService.quote('order-1', 'seller-1', parcel);
    assert.equal(quote.deliveryAmountKopecks, 24700);
    assert.deepEqual({ weightGrams: sent.weightGrams, lengthCm: sent.lengthCm,
      widthCm: sent.widthCm, heightCm: sent.heightCm },
    { weightGrams: 520, lengthCm: 22, widthCm: 15, heightCm: 12 });
    await orderPackingService.confirm('order-1', 'seller-1', parcel, 24700);
    assert.equal(updated.packedWeightGrams, 520);
    assert.equal(updated.packedDeliveryAmountKopecks, 24700);
    assert.equal(updated.deliveryAmountKopecks, 24700);
    assert.equal(updated.isPacked, true);
    assert.equal(order.total, 149900);
    assert.equal(order.deliveryChargedToBuyerKopecks, 0);
  } finally {
    (prisma.order.findFirst as any) = original.orderFind;
    (prisma.orderShipment.findUnique as any) = original.shipmentFind;
    (prisma.$transaction as any) = original.transaction;
    (cdekService.calculateDelivery as any) = original.calculate;
  }
});

test('packing requires paid production order and rejects a CDEK quote failure without DB writes', async () => {
  const order: any = makeOrder();
  let writes = 0;
  try {
    (prisma.order.findFirst as any) = async () => order;
    (prisma.orderShipment.findUnique as any) = async () => null;
    (cdekService.calculateDelivery as any) = async () => { throw new Error('CDEK_DOWN'); };
    (prisma.$transaction as any) = async () => { writes++; };
    order.paymentStatus = 'PENDING_PAYMENT';
    await assert.rejects(orderPackingService.confirm('order-1', 'seller-1', parcel, 24700), /PAYMENT_REQUIRED/);
    order.paymentStatus = 'PAID';
    order.status = 'PAID';
    await assert.rejects(orderPackingService.confirm('order-1', 'seller-1', parcel, 24700), /PRODUCTION_NOT_STARTED/);
    order.status = 'PRINTING';
    await assert.rejects(orderPackingService.confirm('order-1', 'seller-1', parcel, 24700), /CDEK_QUOTE_FAILED/);
    assert.equal(writes, 0);
  } finally {
    (prisma.order.findFirst as any) = original.orderFind;
    (prisma.orderShipment.findUnique as any) = original.shipmentFind;
    (prisma.$transaction as any) = original.transaction;
    (cdekService.calculateDelivery as any) = original.calculate;
  }
});

test('packing quote carries its correlation id to the CDEK calculator', async () => {
  const order: any = makeOrder();
  let trace: unknown;
  try {
    (prisma.order.findFirst as any) = async () => order;
    (prisma.orderShipment.findUnique as any) = async () => null;
    (cdekService.calculateDelivery as any) = async (_input: unknown, observed: unknown) => {
      trace = observed;
      return { totalSum: 204.75, deliverySum: 204.75, deliveryDaysMin: 2, deliveryDaysMax: 4 };
    };
    const result = await orderPackingService.quote(order.id, 'seller-1', parcel, 'trace-123');
    assert.equal(result.deliveryAmountKopecks, 20475);
    assert.deepEqual(trace, { requestId: 'trace-123', orderId: order.id });
  } finally {
    (prisma.order.findFirst as any) = original.orderFind;
    (prisma.orderShipment.findUnique as any) = original.shipmentFind;
    (cdekService.calculateDelivery as any) = original.calculate;
  }
});
