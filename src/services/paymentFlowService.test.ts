import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { paymentFlowService } from './paymentFlowService';
import { prisma } from '../lib/prisma';
import { orderUseCases } from '../usecases/orderUseCases';
import { yookassaService } from './yookassaService';

const inputBase = {
  buyerId: 'buyer-1',
  recipient: { name: 'Иван Иванов', phone: '+79990000000', email: 'ivan@test.dev' },
  buyerPickupPvz: { provider: 'CDEK' as const, pvzId: 'pvz-1' },
  items: [{ productId: 'product-1', quantity: 1 }]
};

test('startPayment double-click with same paymentAttemptKey -> 1 order, 1 payment', async () => {
  let orderCreateCalls = 0;
  let paymentCreateCalls = 0;
  (yookassaService.createPayment as any) = async () => ({
    id: 'ext-pay-1',
    confirmationUrl: 'https://yookassa.test/pay-1',
    status: 'pending',
    payload: { paymentUrl: 'https://yookassa.test/pay-1' }
  });

  (prisma.order.findFirst as any) = async ({ where }: any) => {
    if (where.paymentAttemptKey === 'attempt-1' && orderCreateCalls > 0) {
      return {
        id: 'order-1',
        total: 100,
        currency: 'RUB',
        packagesCount: 1,
        orderLabels: [{ packageNo: 1, code: 'PF-1' }],
        recipientName: 'Иван Иванов',
        recipientPhone: '+79990000000'
      };
    }
    return null;
  };
  (prisma.product.findMany as any) = async () => ([{ id: 'product-1', sellerId: 'seller-1' }]);
  (prisma.sellerSettings.findUnique as any) = async () => ({ defaultDropoffPvzId: 'dropoff-1', defaultDropoffPvzMeta: {} });
  (prisma.sellerDeliveryProfile.findUnique as any) = async () => ({ dropoffStationId: '10022023854' });
  (orderUseCases.create as any) = async () => {
    orderCreateCalls += 1;
    if (orderCreateCalls === 1) {
      return { id: 'order-1', total: 100, currency: 'RUB', packagesCount: 1, orderLabels: [] };
    }
    throw new Prisma.PrismaClientKnownRequestError('Unique', {
      code: 'P2002',
      clientVersion: '5.18.0',
      meta: { target: ['buyerId', 'paymentAttemptKey'] }
    });
  };
  (prisma.order.update as any) = async ({ data }: any) => ({ id: 'order-1', total: 100, currency: 'RUB', packagesCount: 1, ...data });

  let paymentFindCalls = 0;
  (prisma.payment.findFirst as any) = async () => {
    paymentFindCalls += 1;
    if (paymentFindCalls > 1) return { id: 'pay-1', payloadJson: { paymentUrl: 'https://yookassa.test/pay-1' } };
    return null;
  };
  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      order: {
        findUnique: async () => ({ id: 'order-1', total: 100, currency: 'RUB', paymentId: null }),
        updateMany: async () => ({ count: 1 }),
        findUniqueOrThrow: async () => ({})
      },
      payment: {
        findUnique: async () => null,
        create: async () => {
          paymentCreateCalls += 1;
          return { id: 'pay-1', provider: 'yookassa' };
        },
        update: async () => ({}),
        delete: async () => ({})
      }
    });

  const first = await paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-1' });
  const second = await paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-1' });

  assert.equal(first.orderId, second.orderId);
  assert.equal(paymentCreateCalls, 1);
});

test('startPayment with different paymentAttemptKey creates new order', async () => {
  let createdOrders = 0;
  (prisma.order.findFirst as any) = async () => null;
  (prisma.product.findMany as any) = async () => ([{ id: 'product-1', sellerId: 'seller-1' }]);
  (yookassaService.createPayment as any) = async ({ orderId }: any) => ({
    id: `ext-${orderId}`,
    confirmationUrl: `https://yookassa.test/${orderId}`,
    status: 'pending',
    payload: { paymentUrl: `https://yookassa.test/${orderId}` }
  });
  (prisma.sellerSettings.findUnique as any) = async () => ({ defaultDropoffPvzId: 'dropoff-1', defaultDropoffPvzMeta: {} });
  (prisma.sellerDeliveryProfile.findUnique as any) = async () => ({ dropoffStationId: '10022023854' });
  (orderUseCases.create as any) = async ({ paymentAttemptKey }: any) => {
    createdOrders += 1;
    return { id: `order-${paymentAttemptKey}`, total: 100, currency: 'RUB', packagesCount: 1, orderLabels: [] };
  };
  (prisma.order.update as any) = async ({ where, data }: any) => ({ id: where.id, total: 100, currency: 'RUB', packagesCount: 1, ...data });
  (prisma.payment.findFirst as any) = async () => null;
  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      order: {
        findUnique: async ({ where }: any) => ({ id: where.id, total: 100, currency: 'RUB', paymentId: null }),
        updateMany: async () => ({ count: 1 })
      },
      payment: {
        findUnique: async () => null,
        create: async ({ data }: any) => ({ id: `pay-${data.orderId}`, provider: 'yookassa' }),
        update: async () => ({}),
        delete: async () => ({})
      }
    });

  const first = await paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-A' });
  const second = await paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-B' });

  assert.notEqual(first.orderId, second.orderId);
  assert.equal(createdOrders, 2);
});

test('webhook success makes order PAID and sets paidAt', async () => {
  (prisma.payment.findFirst as any) = async () => ({ id: 'pay-1', provider: 'yookassa', orderId: 'order-1', order: { id: 'order-1' } });

  let updatedOrderData: any = null;
  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      order: {
        findUnique: async () => ({ id: 'order-1', status: 'CREATED' }),
        update: async ({ data }: any) => {
          updatedOrderData = data;
          return {};
        },
        updateMany: async () => ({ count: 0 })
      },
      payment: { update: async () => ({}) }
    });

  await paymentFlowService.processWebhook({ externalId: 'ext-pay-1', status: 'success' });
  assert.equal(updatedOrderData.status, 'PAID');
  assert.ok(updatedOrderData.paidAt instanceof Date);
});


test('startPayment allows checkout when seller dropoff config is missing without blocking flags', async () => {
  (prisma.order.findFirst as any) = async () => null;
  (prisma.product.findMany as any) = async () => ([{ id: 'product-1', sellerId: 'seller-1' }]);
  (yookassaService.createPayment as any) = async ({ orderId }: any) => ({
    id: `ext-${orderId}`,
    confirmationUrl: `https://yookassa.test/${orderId}`,
    status: 'pending',
    payload: { paymentUrl: `https://yookassa.test/${orderId}` }
  });
  (prisma.sellerSettings.findUnique as any) = async () => ({ defaultDropoffPvzId: null, defaultDropoffPvzMeta: null });

  let createdPayload: any = null;
  (orderUseCases.create as any) = async (payload: any) => {
    createdPayload = payload;
    return {
      id: 'order-missing-dropoff',
      total: 100,
      currency: 'RUB',
      packagesCount: 1,
      orderLabels: [],
      sellerDropoffPvzId: null,
      recipientName: payload.recipient.name,
      recipientPhone: payload.recipient.phone
    };
  };
  (prisma.order.update as any) = async ({ where, data }: any) => ({
    id: where.id,
    total: 100,
    currency: 'RUB',
    packagesCount: 1,
    sellerDropoffPvzId: null,
    ...data
  });
  (prisma.payment.findFirst as any) = async () => null;
  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      order: {
        findUnique: async ({ where }: any) => ({ id: where.id, total: 100, currency: 'RUB', paymentId: null }),
        updateMany: async () => ({ count: 1 })
      },
      payment: {
        findUnique: async () => null,
        create: async ({ data }: any) => ({ id: `pay-${data.orderId}`, provider: 'yookassa' }),
        update: async () => ({}),
        delete: async () => ({})
      }
    });

  const result = await paymentFlowService.startPayment({ ...inputBase, paymentAttemptKey: 'attempt-missing-dropoff' });

  assert.equal(createdPayload.sellerDropoffPvz, undefined);
  assert.equal(result.deliveryConfigMissing, false);
  assert.equal(result.blockingReason, null);
});


test('startPayment rejects multi-seller checkout items', async () => {
  (prisma.order.findFirst as any) = async () => null;
  (prisma.product.findMany as any) = async () => ([
    { id: 'product-1', sellerId: 'seller-1' },
    { id: 'product-2', sellerId: 'seller-2' }
  ]);

  await assert.rejects(
    () =>
      paymentFlowService.startPayment({
        ...inputBase,
        paymentAttemptKey: 'attempt-multi-seller',
        items: [
          { productId: 'product-1', quantity: 1 },
          { productId: 'product-2', quantity: 2 }
        ]
      }),
    /MULTI_SELLER_CHECKOUT_NOT_SUPPORTED/
  );
});
