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
      id: 'order-1', status: 'PRINTING', paymentStatus: 'PAID', paidAt: new Date(), isPacked: true,
      packedWeightGrams: 1300, packedLengthCm: 30.2, packedWidthCm: 20, packedHeightCm: 32.1,
      packedDeliveryAmountKopecks: 24700,
      packedQuoteCalculatedAt: new Date(),
      buyerPickupPvzId: 'MSK123', sellerDropoffPvzId: 'SPB123',
      buyerPickupPvzMeta: { provider: 'CDEK' },
      shippingSnapshot: snapshot,
      recipientName: 'Test', recipientPhone: '+79990000000',
      items: [{ id: 'item-1', productId: 'a', quantity: 3, priceAtPurchase: 10000,
        product: { id: 'a', sellerId: 'seller', title: 'Part', sku: 'A',
          weightGrossG: 1, dxCm: 1, dyCm: 1, dzCm: 1,
          seller: { name: 'Seller', fullName: 'Seller Full', phone: '+79991234567',
            sellerProfile: { contactName: 'Contact', contactPhone: '+79991234567', representativeName: null,
              storeName: 'Store', phone: '+79991234567' } } }, variant: null }],
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
      $queryRaw: async () => [{ id: 'order-1' }],
      orderShipment: { upsert: async () => ({ id: 'shipment-1' }) },
      order: {
        findUnique: async () => ({
          id: 'order-1', status: 'PRINTING', paymentStatus: 'PAID', paidAt: new Date(),
          isPacked: true, packedWeightGrams: 1300, packedLengthCm: 30.2,
          packedWidthCm: 20, packedHeightCm: 32.1, packedDeliveryAmountKopecks: 24700,
          readyForShipmentAt: null, shipment: null, cdekOrderId: null
        }),
        update: async () => ({})
      },
      orderShipmentStatusHistory: { create: async () => ({}) }
    });
    await createShipmentCdek('order-1', 'seller');
    assert.deepEqual({
      weightGrams: sent.weightGrams, lengthCm: sent.lengthCm,
      widthCm: sent.widthCm, heightCm: sent.heightCm
    }, { weightGrams: 1300, lengthCm: 31, widthCm: 20, heightCm: 33 });
    assert.equal(sent.items[0].weight, 350);
    assert.equal(sent.senderName, 'Contact');
    assert.equal(sent.senderPhone, '+79991234567');
    assert.equal(sent.recipientPhone, '+79990000000');
  } finally {
    (prisma.order.findUnique as any) = originalOrder;
    (prisma.payment.findFirst as any) = originalPayment;
    (prisma.orderShipment.findUnique as any) = originalShipment;
    (prisma.$transaction as any) = originalTransaction;
    (cdekService.createOrderFromMarketplaceOrder as any) = originalCreate;
    (cdekService.getOrderByUuid as any) = originalGet;
  }
});

test('missing seller or recipient contacts and multiple sellers block before CDEK POST', async () => {
  const originalOrder = prisma.order.findUnique;
  const originalShipment = prisma.orderShipment.findUnique;
  const originalCreate = cdekService.createOrderFromMarketplaceOrder;
  let cdekCalls = 0;
  const makeOrder = () => ({
    id: 'order-guard', status: 'PRINTING', paymentStatus: 'PAID', paidAt: new Date(), isPacked: true,
    packedWeightGrams: 500, packedLengthCm: 12, packedWidthCm: 12, packedHeightCm: 12,
    packedDeliveryAmountKopecks: 24700,
    packedQuoteCalculatedAt: new Date(),
    buyerPickupPvzId: 'MSK123', sellerDropoffPvzId: 'SPB123',
    buyerPickupPvzMeta: { provider: 'CDEK' }, sellerDropoffPvzMeta: { provider: 'CDEK' },
    shippingSnapshot: buildShippingSnapshot([
      { productId: 'product-1', quantity: 1, weightGrossG: 300, dxCm: 10, dyCm: 10, dzCm: 10 }
    ]),
    recipientName: 'Buyer', recipientPhone: '+79997654321',
    items: [{ id: 'item-1', productId: 'product-1', quantity: 1, priceAtPurchase: 10000,
      product: { sellerId: 'seller-1', title: 'Part', sku: 'SKU',
        seller: { name: 'Seller', fullName: 'Full Seller', phone: '+79991234567',
          sellerProfile: { contactName: 'Contact', contactPhone: '+79991234567',
            representativeName: 'Representative', storeName: 'Store', phone: '+79991234567' } } },
      variant: null }], buyer: {}, contact: null
  });
  try {
    (prisma.orderShipment.findUnique as any) = async () => null;
    (cdekService.createOrderFromMarketplaceOrder as any) = async () => { cdekCalls++; throw new Error('MUST_NOT_CALL_CDEK'); };
    const cases: Array<{ mutate: (order: any) => void; code: string }> = [
      { mutate: order => { order.packedWeightGrams = null; }, code: 'PACKED_PARCEL_REQUIRED' },
      { mutate: order => { const s = order.items[0].product.seller; s.name = ''; s.fullName = '';
        s.sellerProfile.contactName = ''; s.sellerProfile.representativeName = ''; s.sellerProfile.storeName = ''; },
        code: 'CDEK_SENDER_NAME_REQUIRED' },
      { mutate: order => { const s = order.items[0].product.seller; s.phone = '';
        s.sellerProfile.contactPhone = ''; s.sellerProfile.phone = ''; }, code: 'CDEK_SENDER_PHONE_REQUIRED' },
      { mutate: order => { order.items[0].product.seller.sellerProfile.contactPhone = '+70000000000'; },
        code: 'CDEK_SENDER_PHONE_INVALID' },
      { mutate: order => { order.recipientPhone = ''; }, code: 'RECIPIENT_PHONE_REQUIRED' },
      { mutate: order => { order.packedWeightGrams = 650; order.shippingSnapshot = buildShippingSnapshot([
        { productId: 'product-1', quantity: 2, weightGrossG: 300, dxCm: 10, dyCm: 10, dzCm: 10 }
      ]); }, code: 'SHIPPING_SNAPSHOT_INVALID' },
      { mutate: order => { order.items.push({ ...order.items[0], id: 'item-2',
        product: { ...order.items[0].product, sellerId: 'seller-2' } }); },
        code: 'MULTI_SELLER_CHECKOUT_NOT_SUPPORTED' }
    ];
    for (const item of cases) {
      const order: any = makeOrder();
      item.mutate(order);
      (prisma.order.findUnique as any) = async () => order;
      await assert.rejects(createShipmentCdek(order.id, 'seller-1'),
        (error: any) => error.message === item.code);
    }
    assert.equal(cdekCalls, 0);
  } finally {
    (prisma.order.findUnique as any) = originalOrder;
    (prisma.orderShipment.findUnique as any) = originalShipment;
    (cdekService.createOrderFromMarketplaceOrder as any) = originalCreate;
  }
});
