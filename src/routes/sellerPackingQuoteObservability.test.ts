import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sellerRoutes } from './sellerRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { orderPackingService } from '../services/orderPackingService';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const app = express();
app.use(express.json());
app.use('/seller', sellerRoutes);
app.use(errorHandler);
const auth = `Bearer ${jwt.sign({ userId: 'seller-1', role: 'SELLER', scope: 'access' }, env.jwtSecret)}`;

test('seller pack/quote returns the same server request id sent through the service', async () => {
  const originalUser = prisma.user.findUnique;
  const originalQuote = orderPackingService.quote;
  const originalLog = console.info;
  let received: unknown;
  const logs: Array<[string, Record<string, unknown>]> = [];
  try {
    (prisma.user.findUnique as any) = async () => ({ role: 'SELLER', sellerProfile: { id: 'profile-1', status: 'APPROVED' } });
    (orderPackingService.quote as any) = async (...args: unknown[]) => {
      received = args;
      return { deliveryAmountKopecks: 20475, deliveryDaysMin: 2, deliveryDaysMax: 4 };
    };
    (console.info as any) = (label: string, fields: Record<string, unknown>) => { logs.push([label, fields]); };
    const response = await request(app).post('/seller/orders/order-17/pack/quote')
      .set('Authorization', auth)
      .send({ weightGrams: 250, lengthCm: 15, widthCm: 15, heightCm: 15 });
    assert.equal(response.status, 200);
    assert.match(response.body.data.requestId, /^[0-9a-f-]{36}$/i);
    assert.equal(response.headers['x-request-id'], response.body.data.requestId);
    assert.deepEqual(received, ['order-17', 'seller-1',
      { weightGrams: 250, lengthCm: 15, widthCm: 15, heightCm: 15 }, response.body.data.requestId]);
    assert.equal(logs.find(([label]) => label === '[seller pack/quote][response]')?.[1]?.requestId,
      response.body.data.requestId);
  } finally {
    (prisma.user.findUnique as any) = originalUser;
    (orderPackingService.quote as any) = originalQuote;
    (console.info as any) = originalLog;
  }
});
