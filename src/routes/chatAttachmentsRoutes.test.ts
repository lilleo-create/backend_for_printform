import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { chatRoutes } from './chatRoutes';
import { adminChatRoutes } from './adminChatRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { privateChatDir } from '../services/privateFileStorage';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const auth = (id: string, role: 'BUYER' | 'ADMIN') => `Bearer ${jwt.sign({ userId: id, role, scope: 'access' }, env.jwtSecret)}`;
const app = () => {
  const server = express();
  server.use(express.json());
  server.use('/chats', chatRoutes);
  server.use('/admin/chats', adminChatRoutes);
  server.use(errorHandler);
  return server;
};
const cleanup = async (url: string) => fs.unlink(path.join(privateChatDir, path.basename(url))).catch(() => undefined);

test('buyer can send photo-only first message; attachment is returned with thread history', async () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'BUYER' });
  const now = new Date();
  const persisted: any[] = [];
  (prisma.$transaction as any) = async (callback: any) => callback({
    chatThread: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({ ...data, id: 'chat-1' }),
      update: async () => ({ id: 'chat-1', status: 'ACTIVE', kind: 'SUPPORT' })
    },
    chatMessage: {
      create: async ({ data }: any) => {
        const message = { ...data, id: `message-${persisted.length + 1}`, createdAt: now,
          attachments: (data.attachments?.create ?? []).map((attachment: any) => ({ id: 'attachment-1', messageId: 'message-1', ...attachment })) };
        persisted.push(message);
        return message;
      }
    }
  });
  const response = await request(app()).post('/chats/support/messages')
    .set('Authorization', auth('buyer-1', 'BUYER'))
    .field('topic', 'Доставка').field('text', '')
    .attach('files', png, { filename: 'photo.png', contentType: 'image/png' });
  assert.equal(response.status, 201);
  const attachment = response.body.data.userMessage.attachments[0];
  try {
    assert.equal(response.body.data.userMessage.text, '');
    assert.equal(attachment.type, 'IMAGE');
    assert.ok(attachment.url.startsWith('/private-files/chats/'));
    assert.equal(response.body.data.acknowledgementMessage.text, 'Сейчас позову оператора.');
    (prisma.chatThread.findFirst as any) = async () => ({ id: 'chat-1', kind: 'SUPPORT', status: 'ACTIVE', userId: 'buyer-1' });
    (prisma.chatMessage.findMany as any) = async () => [...persisted].reverse();
    const history = await request(app()).get('/chats/chat-1').set('Authorization', auth('buyer-1', 'BUYER'));
    assert.equal(history.status, 200);
    assert.equal(history.body.data.messages[0].attachments[0].url, attachment.url);
  } finally { await cleanup(attachment.url); }
});

test('buyer cannot submit arbitrary attachment URLs or SVG files', async () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'BUYER' });
  const external = await request(app()).post('/chats/support/messages')
    .set('Authorization', auth('buyer-1', 'BUYER'))
    .send({ text: 'Фото', attachments: [{ url: 'https://example.com/image.png' }] });
  assert.equal(external.status, 400);
  const svg = await request(app()).post('/chats/support/messages')
    .set('Authorization', auth('buyer-1', 'BUYER'))
    .field('text', 'Фото')
    .attach('files', Buffer.from('<svg/>'), { filename: 'bad.svg', contentType: 'image/svg+xml' });
  assert.equal(svg.status, 400);
});

test('admin can reply with a photo and sees it in history', async () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'ADMIN' });
  (prisma.chatThread.findUnique as any) = async () => ({ id: 'chat-1', kind: 'SUPPORT', status: 'ACTIVE', deletedAt: null });
  const now = new Date();
  let saved: any;
  (prisma.$transaction as any) = async (callback: any) => callback({
    chatMessage: { create: async ({ data }: any) => {
      saved = { ...data, id: 'admin-message', createdAt: now,
        attachments: (data.attachments?.create ?? []).map((attachment: any) => ({ id: 'admin-photo', messageId: 'admin-message', ...attachment })) };
      return saved;
    } },
    chatThread: { update: async () => ({}) }
  });
  const response = await request(app()).post('/admin/chats/chat-1/messages')
    .set('Authorization', auth('admin-1', 'ADMIN'))
    .field('text', 'Посмотрите фото')
    .attach('files', png, { filename: 'answer.png', contentType: 'image/png' });
  assert.equal(response.status, 201);
  const attachment = response.body.data.attachments[0];
  try {
    assert.equal(response.body.data.authorRole, 'ADMIN');
    assert.equal(attachment.type, 'IMAGE');
    (prisma.chatMessage.findMany as any) = async () => [saved];
    const history = await request(app()).get('/admin/chats/chat-1').set('Authorization', auth('admin-1', 'ADMIN'));
    assert.equal(history.status, 200);
    assert.equal(history.body.data.messages[0].attachments[0].url, attachment.url);
  } finally { await cleanup(attachment.url); }
});
