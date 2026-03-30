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
  (prisma.order.findUnique as any) = async () => ({ id: 'order-1', total: 100, status: 'CREATED' });
  (prisma.payment.findFirst as any) = async () => ({ id: 'pay-1', provider: 'yookassa', orderId: 'order-1', order: { id: 'order-1' }, status: 'PENDING' });
  (prisma.payment.updateMany as any) = async () => ({ count: 1 });

  let updatedOrderData: any = null;
  (prisma.order.update as any) = async ({ data }: any) => {
    updatedOrderData = data;
    return {};
  };

  await paymentFlowService.processWebhook({
    externalId: 'ext-pay-1',
    status: 'succeeded',
    orderId: 'order-1',
    amount: '1.00'
  });
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

test('createOrderCancellationRefund marks order CANCELLED with REFUND_PENDING after refund create', async () => {
  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      order: {
        findFirst: async () => ({
          id: 'order-1',
          buyerId: 'buyer-1',
          paymentStatus: 'PAID',
          status: 'PAID',
          total: 10000,
          currency: 'RUB',
          payoutStatus: 'HOLD',
          shipment: null,
          cdekStatus: null,
          payments: [{ externalId: 'ext-pay-1', status: 'SUCCEEDED' }]
        }),
        update: async ({ data }: any) => ({ id: 'order-1', ...data })
      },
      refund: {
        aggregate: async ({ where }: any) => ({ _sum: { amount: where.status === 'SUCCEEDED' ? 0 : 0 } }),
        create: async ({ data }: any) => ({ id: 'refund-1', ...data })
      }
    });

  (yookassaService.createRefund as any) = async () => ({
    id: 'ext-refund-1',
    status: 'pending',
    payload: { id: 'ext-refund-1', status: 'pending' }
  });

  const { order, refund } = await paymentFlowService.createOrderCancellationRefund({
    orderId: 'order-1',
    buyerId: 'buyer-1'
  });

  assert.equal(order.status, 'CANCELLED');
  assert.equal(order.paymentStatus, 'REFUND_PENDING');
  assert.equal(order.payoutStatus, 'BLOCKED');
  assert.equal(refund.externalId, 'ext-refund-1');
});

test('createOrderCancellationRefund throws REFUND_CREATE_FAILED when YooKassa refund create fails', async () => {
  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      order: {
        findFirst: async () => ({
          id: 'order-1',
          buyerId: 'buyer-1',
          paymentStatus: 'PAID',
          status: 'PAID',
          total: 10000,
          currency: 'RUB',
          payoutStatus: 'HOLD',
          shipment: null,
          cdekStatus: null,
          payments: [{ externalId: 'ext-pay-1', status: 'SUCCEEDED' }]
        })
      },
      refund: {
        aggregate: async ({ where }: any) => ({ _sum: { amount: where.status === 'SUCCEEDED' ? 0 : 0 } })
      }
    });

  (yookassaService.createRefund as any) = async () => {
    throw new Error('YOOKASSA_REFUND_CREATE_FAILED');
  };

  await assert.rejects(
    () => paymentFlowService.createOrderCancellationRefund({ orderId: 'order-1', buyerId: 'buyer-1' }),
    /REFUND_CREATE_FAILED/
  );
});

test('refund webhook is idempotent and does not update order twice', async () => {
  let updateOrderCalls = 0;
  let updateManyCalls = 0;
  (prisma.refund.findFirst as any) = async () => ({
    id: 'refund-1',
    orderId: 'order-1',
    paymentId: 'ext-pay-1',
    amount: 10000,
    order: { id: 'order-1', total: 10000 }
  });
  (prisma.refund.updateMany as any) = async () => {
    updateManyCalls += 1;
    return { count: updateManyCalls === 1 ? 1 : 0 };
  };
  (prisma.order.update as any) = async () => {
    updateOrderCalls += 1;
    return {};
  };

  await paymentFlowService.processRefundWebhook({
    externalRefundId: 'ext-refund-1',
    amount: '100.00'
  });
  await paymentFlowService.processRefundWebhook({
    externalRefundId: 'ext-refund-1',
    amount: '100.00'
  });

  assert.equal(updateOrderCalls, 1);
});
