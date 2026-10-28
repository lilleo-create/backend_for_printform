import test from 'node:test';
import assert from 'node:assert/strict';

test('payments/start accepts changed CDEK tariff and charges goods only', async () => {
  process.env.JWT_SECRET = 'test_secret_0123456789_abcdefghijk';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_0123456789_abcdefgh';
  process.env.OTP_HASH_PEPPER = 'test_pepper_0123456789_abcdefghij';
  process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/test';
  process.env.FRONTEND_URL = 'http://localhost:3000';
  const { prisma } = await import('../lib/prisma');
  const { cdekService } = await import('./cdekService');
  const { orderUseCases } = await import('../usecases/orderUseCases');
  const { yookassaService } = await import('./yookassaService');
  const { paymentFlowService } = await import('./paymentFlowService');

  const originals = {
    orderUpdateMany: prisma.order.updateMany, orderFindFirst: prisma.order.findFirst,
    productFindMany: prisma.product.findMany, settingsFind: prisma.sellerSettings.findUnique,
    orderUpdate: prisma.order.update, paymentFind: prisma.payment.findFirst,
    transaction: prisma.$transaction, calculate: cdekService.calculateDelivery,
    createOrder: orderUseCases.create, createPayment: yookassaService.createPayment
  };
  let created: any;
  let charged: any;
  try {
    (prisma.order.updateMany as any) = async () => ({ count: 0 });
    (prisma.order.findFirst as any) = async () => null;
    (prisma.product.findMany as any) = async () => [
      { id: 'a', sellerId: 'seller', weightGrossG: 350, dxCm: 19, dyCm: 12, dzCm: 9.5 }
    ];
    (prisma.sellerSettings.findUnique as any) = async () => ({
      defaultDropoffPvzId: 'MSK123', defaultDropoffPvzMeta: { raw: { city_code: 44 } }
    });
    (cdekService.calculateDelivery as any) = async () => ({
      totalSum: 210, deliverySum: 210, deliveryDaysMin: 2, deliveryDaysMax: 4
    });
    (orderUseCases.create as any) = async (input: any) => {
      created = input;
      return { id: 'order-1', total: 150000,
        currency: 'RUB', packagesCount: 1, orderLabels: [],
        shippingSnapshot: input.shippingSnapshot,
        deliveryAmountKopecks: input.deliveryAmountKopecks };
    };
    (prisma.order.update as any) = async ({ data }: any) => ({
      id: 'order-1', total: 150000, currency: 'RUB', packagesCount: 1,
      shippingSnapshot: created.shippingSnapshot,
      deliveryAmountKopecks: created.deliveryAmountKopecks, ...data
    });
    (prisma.payment.findFirst as any) = async () => null;
    (prisma.$transaction as any) = async (callback: any) => callback({
      order: {
        findUnique: async () => ({ id: 'order-1', total: 150000, currency: 'RUB', paymentId: null }),
        updateMany: async () => ({ count: 1 })
      },
      payment: { create: async () => ({ id: 'payment-1', provider: 'yookassa' }) }
    });
    (yookassaService.createPayment as any) = async (input: any) => {
      charged = input;
      return { id: 'external-1', confirmationUrl: 'https://pay.test/1',
        payload: { paymentUrl: 'https://pay.test/1' } };
    };
    await paymentFlowService.startPayment({
      buyerId: 'buyer', paymentAttemptKey: 'attempt-1',
      recipient: { name: 'Test', phone: '+79990000000' },
      buyerPickupPvz: { pvzId: 'SPB123', raw: { city_code: 137 } },
      items: [{ productId: 'a', quantity: 1, expectedPriceKopecks: 150000 }],
      expectedDeliveryAmountKopecks: 20475,
      expectedShippingSnapshot: { source: 'checkout', totalWeightGrams: 350,
        items: [{ weightGrossG: 350, quantity: 1, productId: 'a' }],
        packages: [{ heightCm: 10, widthCm: 12, lengthCm: 19, weightGrams: 350 }] }
    });
    assert.equal(created.deliveryAmountKopecks, 21000);
    assert.equal(created.deliveryChargedToBuyerKopecks, 0);
    assert.equal(created.shippingSnapshot.packages[0].weightGrams, 350);
    assert.equal(charged.amount, 150000);
  } finally {
    (prisma.order.updateMany as any) = originals.orderUpdateMany;
    (prisma.order.findFirst as any) = originals.orderFindFirst;
    (prisma.product.findMany as any) = originals.productFindMany;
    (prisma.sellerSettings.findUnique as any) = originals.settingsFind;
    (prisma.order.update as any) = originals.orderUpdate;
    (prisma.payment.findFirst as any) = originals.paymentFind;
    (prisma.$transaction as any) = originals.transaction;
    (cdekService.calculateDelivery as any) = originals.calculate;
    (orderUseCases.create as any) = originals.createOrder;
    (yookassaService.createPayment as any) = originals.createPayment;
  }
});

test('payments/start creates neither order nor YooKassa payment when city or CDEK quote fails', async () => {
  process.env.JWT_SECRET = 'test_secret_0123456789_abcdefghijk';
  process.env.JWT_REFRESH_SECRET = 'test_refresh_0123456789_abcdefgh';
  process.env.OTP_HASH_PEPPER = 'test_pepper_0123456789_abcdefghij';
  process.env.DATABASE_URL = 'postgresql://invalid:invalid@127.0.0.1:1/test';
  process.env.FRONTEND_URL = 'http://localhost:3000';
  const { prisma } = await import('../lib/prisma');
  const { cdekService } = await import('./cdekService');
  const { orderUseCases } = await import('../usecases/orderUseCases');
  const { yookassaService } = await import('./yookassaService');
  const { paymentFlowService } = await import('./paymentFlowService');
  const originals = {
    orderUpdateMany: prisma.order.updateMany, orderFindFirst: prisma.order.findFirst,
    productFindMany: prisma.product.findMany, settingsFind: prisma.sellerSettings.findUnique,
    calculate: cdekService.calculateDelivery, cityCode: cdekService.getCityCodeByPvzCode,
    createOrder: orderUseCases.create,
    createPayment: yookassaService.createPayment
  };
  let orderCreates = 0;
  let paymentCreates = 0;
  try {
    (prisma.order.updateMany as any) = async () => ({ count: 0 });
    (prisma.order.findFirst as any) = async () => null;
    (prisma.product.findMany as any) = async () => [
      { id: 'a', sellerId: 'seller', weightGrossG: 350, dxCm: 19, dyCm: 12, dzCm: 9.5 }
    ];
    (prisma.sellerSettings.findUnique as any) = async () => ({
      defaultDropoffPvzId: 'MSK123', defaultDropoffPvzMeta: { raw: { city_code: 44 } }
    });
    (cdekService.getCityCodeByPvzCode as any) = async () => null;
    (orderUseCases.create as any) = async () => { orderCreates++; };
    (yookassaService.createPayment as any) = async () => { paymentCreates++; };
    const base = {
      buyerId: 'buyer', paymentAttemptKey: 'attempt-error',
      recipient: { name: 'Test', phone: '+79990000000' },
      items: [{ productId: 'a', quantity: 1 }]
    };
    await assert.rejects(paymentFlowService.startPayment({
      ...base, buyerPickupPvz: { pvzId: 'SPB123', raw: {} }
    }), { code: 'BUYER_CITY_CODE_REQUIRED' });
    (cdekService.calculateDelivery as any) = async () => { throw new Error('offline'); };
    await assert.rejects(paymentFlowService.startPayment({
      ...base, buyerPickupPvz: { pvzId: 'SPB123', raw: { city_code: 137 } }
    }), { code: 'CDEK_QUOTE_FAILED' });
    assert.equal(orderCreates, 0);
    assert.equal(paymentCreates, 0);
  } finally {
    (prisma.order.updateMany as any) = originals.orderUpdateMany;
    (prisma.order.findFirst as any) = originals.orderFindFirst;
    (prisma.product.findMany as any) = originals.productFindMany;
    (prisma.sellerSettings.findUnique as any) = originals.settingsFind;
    (cdekService.calculateDelivery as any) = originals.calculate;
    (cdekService.getCityCodeByPvzCode as any) = originals.cityCode;
    (orderUseCases.create as any) = originals.createOrder;
    (yookassaService.createPayment as any) = originals.createPayment;
  }
});
