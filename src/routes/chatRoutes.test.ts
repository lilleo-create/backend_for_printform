import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { chatRoutes } from './chatRoutes';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const tokenFor = (userId: string) => jwt.sign({ userId, role: 'BUYER', scope: 'access' }, env.jwtSecret);

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/chats', chatRoutes);
  return app;
};

test('POST /chats/threads returns existing seller thread for same buyer + seller/shop pair', async () => {
  (prisma.user.findUnique as any) = async ({ where }: any) => {
    if (where.id === 'buyer-1') return { role: 'BUYER' };
    return null;
  };

  let findFirstCalls = 0;
  (prisma.user.findFirst as any) = async () => ({ id: 'seller-1' });
  (prisma.chatThread.findFirst as any) = async () => {
    findFirstCalls += 1;
    if (findFirstCalls === 1) {
      return null;
    }
    return {
      id: 'thread-seller-1',
      kind: 'SELLER',
      userId: 'buyer-1',
      sellerId: 'seller-1',
      shopId: 'seller-1',
      supportTopic: null,
      status: 'ACTIVE',
      returnRequestId: null,
      lastMessageAt: null,
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z'),
      returnRequest: null
    };
  };
  (prisma.chatThread.create as any) = async () => ({
    id: 'thread-seller-1',
    kind: 'SELLER',
    userId: 'buyer-1',
    sellerId: 'seller-1',
    shopId: 'seller-1',
    supportTopic: null,
    status: 'ACTIVE',
    returnRequestId: null,
    lastMessageAt: null,
    createdAt: new Date('2026-03-22T00:00:00.000Z'),
    updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    returnRequest: null
  });

  const app = buildApp();
  const auth = `Bearer ${tokenFor('buyer-1')}`;

  const first = await request(app)
    .post('/chats/threads')
    .set('Authorization', auth)
    .send({ kind: 'SELLER', shopId: 'seller-1' });

  const second = await request(app)
    .post('/chats/threads')
    .set('Authorization', auth)
    .send({ kind: 'SELLER', sellerId: 'seller-1', shopId: 'seller-1' });

  assert.equal(first.status, 201);
  assert.equal(first.body.data.created, true);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.created, false);
  assert.equal(second.body.data.thread.id, 'thread-seller-1');
});

test('POST /chats/threads creates support thread with GENERAL topic fallback', async () => {
  (prisma.user.findUnique as any) = async ({ where }: any) => {
    if (where.id === 'buyer-1') return { role: 'BUYER' };
    return null;
  };
  (prisma.chatThread.create as any) = async ({ data }: any) => ({
    id: 'thread-support-1',
    kind: 'SUPPORT',
    userId: data.userId,
    sellerId: null,
    shopId: null,
    supportTopic: data.supportTopic,
    status: 'ACTIVE',
    returnRequestId: null,
    lastMessageAt: null,
    createdAt: new Date('2026-03-22T00:00:00.000Z'),
    updatedAt: new Date('2026-03-22T00:00:00.000Z'),
    returnRequest: null
  });

  const app = buildApp();
  const auth = `Bearer ${tokenFor('buyer-1')}`;

  const response = await request(app)
    .post('/chats/threads')
    .set('Authorization', auth)
    .send({ kind: 'SUPPORT' });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.created, true);
  assert.equal(response.body.data.topic, 'GENERAL');
  assert.equal(response.body.data.thread.supportTopic, 'GENERAL');
});
