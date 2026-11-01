import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { writeSupportMessage } from './activeSupportChatService';

test('one support thread receives first, second, and different-topic quick questions with one acknowledgement', async () => {
  let current: any = null;
  let nextId = 0;
  const messages: any[] = [];
  (prisma.$transaction as any) = async (callback: any) => callback({
    chatThread: {
      findFirst: async ({ where }: any) => current?.status === 'ACTIVE' && current.userId === where.userId ? current : null,
      create: async ({ data }: any) => { current = { ...data, id: `thread-${++nextId}` }; return current; },
      update: async ({ where, data }: any) => { current = { ...current, ...data, id: where.id }; return current; }
    },
    chatMessage: {
      create: async ({ data }: any) => {
        const message = { ...data, id: `message-${messages.length + 1}`, createdAt: new Date(), attachments: data.attachments?.create ?? [] };
        messages.push(message);
        return message;
      }
    }
  });
  const first = await writeSupportMessage({ userId: 'buyer', topic: 'Оплата', text: 'Вопрос об оплате', attachments: [] });
  const second = await writeSupportMessage({ userId: 'buyer', topic: 'Доставка', text: 'Где заказ?', attachments: [] });
  const third = await writeSupportMessage({ userId: 'buyer', topic: 'Проблема с заказом', text: 'Когда придёт PF-18?', attachments: [] });
  assert.equal(first.thread.id, second.thread.id);
  assert.equal(second.thread.id, third.thread.id);
  assert.equal(nextId, 1);
  assert.equal(messages.filter(message => message.authorRole === 'ADMIN').length, 1);
  assert.equal(second.acknowledgementMessage, null);
  current.status = 'CLOSED';
  const nextConversation = await writeSupportMessage({ userId: 'buyer', topic: 'Доставка', text: 'Новый вопрос', attachments: [] });
  assert.notEqual(nextConversation.thread.id, first.thread.id);
  assert.equal(nextId, 2);
  assert.equal(messages.filter(message => message.authorRole === 'ADMIN').length, 2);
  assert.equal(messages.filter(message => message.threadId === first.thread.id).length, 4);
});

test('unique conflict retries in a new transaction and reuses the winning support thread', async () => {
  let attempts = 0;
  let messageCount = 0;
  (prisma.$transaction as any) = async (callback: any) => {
    attempts += 1;
    return callback({
      chatThread: {
        findFirst: async () => attempts === 1 ? null : { id: 'winner', status: 'ACTIVE', userId: 'buyer' },
        create: async () => { throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: '5.22.0' }); },
        update: async () => ({ id: 'winner', status: 'ACTIVE' })
      },
      chatMessage: { create: async ({ data }: any) => { messageCount += 1; return { ...data, id: 'message', createdAt: new Date() }; } }
    });
  };
  const result = await writeSupportMessage({ userId: 'buyer', topic: 'Доставка', text: 'Где заказ?', attachments: [] });
  assert.equal(attempts, 2);
  assert.equal(result.thread.id, 'winner');
  assert.equal(result.created, false);
  assert.equal(messageCount, 1);
});
