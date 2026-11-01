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

test('legacy POST /chats/threads only returns an existing support thread and never creates an empty one', async () => {
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
  (prisma.chatThread.findFirst as any) = async () => null;

  const app = buildApp();
  const auth = `Bearer ${tokenFor('buyer-1')}`;

  const response = await request(app)
    .post('/chats/threads')
    .set('Authorization', auth)
    .send({ kind: 'SUPPORT' });

  assert.equal(response.status, 409);
  assert.equal(response.body.error.code, 'SUPPORT_MESSAGE_REQUIRED');
});

test('quick support action persists user question and one automated admin acknowledgement', async () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'BUYER' });
  const now = new Date('2026-11-01T10:00:00.000Z');
  const created: any[] = [];
  let threadCreates = 0;
  const tx = {
    chatThread: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        threadCreates += 1;
        return { ...data, id: 'thread-1', createdAt: now };
      },
      update: async ({ data }: any) => ({ id: 'thread-1', kind: 'SUPPORT', status: 'ACTIVE', supportTopic: 'Доставка', ...data })
    },
    chatMessage: {
      create: async ({ data }: any) => {
        const message = { ...data, id: `message-${created.length + 1}`, createdAt: now };
        created.push(message);
        return message;
      }
    }
  };
  (prisma.$transaction as any) = async (callback: any) => callback(tx);
  const response = await request(buildApp()).post('/chats/support/quick-message')
    .set('Authorization', `Bearer ${tokenFor('buyer-1')}`)
    .send({ topic: 'Доставка', text: 'Хочу уточнить срок доставки.' });
  assert.equal(response.status, 201);
  assert.equal(threadCreates, 1);
  assert.equal(created.length, 2);
  assert.deepEqual(created.map(message => message.authorRole), ['USER', 'ADMIN']);
  assert.equal(created[0].authorId, 'buyer-1');
  assert.equal(created[1].authorId, 'SYSTEM_SUPPORT');
  assert.equal(created[1].text, 'Сейчас позову оператора.');
  assert.equal(response.body.data.userMessage.id, 'message-1');
  assert.equal(response.body.data.acknowledgementMessage.id, 'message-2');
});

test('quick support action reuses an active thread without creating another', async () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'BUYER' });
  const now = new Date('2026-11-01T10:00:00.000Z');
  const persisted: any[] = [];
  let threadCreates = 0;
  (prisma.$transaction as any) = async (callback: any) => callback({
    chatThread: {
      findFirst: async () => ({ id: 'existing-thread', kind: 'SUPPORT', status: 'ACTIVE', supportTopic: 'Доставка' }),
      create: async () => { threadCreates += 1; throw new Error('unexpected create'); },
      update: async ({ where, data }: any) => ({ id: where.id, status: 'ACTIVE', ...data })
    },
    chatMessage: {
      create: async ({ data }: any) => {
        persisted.push(data);
        return { ...data, id: `message-${persisted.length}`, createdAt: now };
      }
    }
  });
  const response = await request(buildApp()).post('/chats/support/quick-message')
    .set('Authorization', `Bearer ${tokenFor('buyer-1')}`)
    .send({ topic: 'Доставка', text: 'Где заказ?' });
  assert.equal(response.status, 200);
  assert.equal(response.body.data.created, false);
  assert.equal(response.body.data.thread.id, 'existing-thread');
  assert.equal(threadCreates, 0);
  assert.equal(persisted.length, 1);
});
