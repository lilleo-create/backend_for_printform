import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import { AddressInfo } from 'node:net';
import { paymentRoutes } from './paymentRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const tokenFor = (userId: string) => jwt.sign({ userId, role: 'BUYER', scope: 'access' }, env.jwtSecret);

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/payments', paymentRoutes);
  app.use(errorHandler);
  return app;
};

const sendMockSuccess = async (opts: { paymentId: string; token?: string }) => {
  const app = buildApp();
  const server = app.listen(0);

  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = {};
    if (opts.token) {
      headers.Authorization = `Bearer ${opts.token}`;
    }

    const response = await fetch(`http://127.0.0.1:${port}/payments/${opts.paymentId}/mock-success`, {
      method: 'POST',
      headers
    });

    return response;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

test('mock-success: buyer can pay own payment and order becomes PAID', async () => {
  process.env.NODE_ENV = 'development';

  let orderUpdateData: any = null;
  let paymentLookups = 0;

  (prisma.user.findUnique as any) = async () => ({ role: 'BUYER' });
  (prisma.payment.findUnique as any) = async () => {
    paymentLookups += 1;
    if (paymentLookups === 1) {
      return { id: 'pay-own', provider: 'manual', orderId: 'order-own', order: { buyerId: 'buyer-own' } };
    }

    return { id: 'pay-own', provider: 'manual', orderId: 'order-own', order: { id: 'order-own' } };
  };

  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      order: {
        findUnique: async () => ({ id: 'order-own', status: 'CREATED' }),
        update: async ({ data }: any) => {
          orderUpdateData = data;
          return {};
        },
        updateMany: async () => ({ count: 0 })
      },
      payment: {
        update: async () => ({})
      }
    });

  const response = await sendMockSuccess({ paymentId: 'pay-own', token: tokenFor('buyer-own') });

  assert.equal(response.status, 200);
  assert.equal(orderUpdateData.status, 'PAID');
  assert.ok(orderUpdateData.paidAt instanceof Date);
});

test('mock-success: unauthorized request returns 401', async () => {
  process.env.NODE_ENV = 'development';
  const response = await sendMockSuccess({ paymentId: 'pay-own' });

  assert.equal(response.status, 401);
});

test('mock-success: authorized buyer cannot mock чужой payment', async () => {
  process.env.NODE_ENV = 'development';

  (prisma.user.findUnique as any) = async () => ({ role: 'BUYER' });
  (prisma.payment.findUnique as any) = async () => ({
    id: 'pay-other',
    provider: 'manual',
    orderId: 'order-other',
    order: { buyerId: 'buyer-owner' }
  });

  const response = await sendMockSuccess({ paymentId: 'pay-other', token: tokenFor('buyer-stranger') });

  assert.equal(response.status, 403);
});

test('mock-success: production blocks endpoint', async () => {
  process.env.NODE_ENV = 'production';

  (prisma.user.findUnique as any) = async () => ({ role: 'BUYER' });

  const response = await sendMockSuccess({ paymentId: 'pay-own', token: tokenFor('buyer-own') });

  assert.equal(response.status, 403);
});
