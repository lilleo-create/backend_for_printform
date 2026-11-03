import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { publicUploadGuard } from '../middleware/publicUploadGuard';
import { privateFileRoutes } from './privateFileRoutes';
import { internalRoutes } from './internalRoutes';
import { shipmentsRoutes } from './shipmentsRoutes';
import { shipmentService } from '../services/shipmentService';
import { cdekWebhookService } from '../services/cdekWebhookService';
import { privateChatDir, privateReturnsDir } from '../services/privateFileStorage';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const token = (id: string) => `Bearer ${jwt.sign({ userId: id, role: 'BUYER', scope: 'access' }, env.jwtSecret)}`;
const app = (publicRoot: string) => {
  const server = express();
  server.use(express.json());
  server.use('/uploads', publicUploadGuard, express.static(publicRoot));
  server.use('/private-files', privateFileRoutes);
  server.use('/internal', internalRoutes);
  server.use('/shipments', shipmentsRoutes);
  return server;
};

test('public product media remains readable while private paths and seller documents are not static', async () => {
  const publicRoot = path.join(process.cwd(), 'uploads', 'launch-security-test');
  await fs.mkdir(path.join(publicRoot, 'chats'), { recursive: true });
  await fs.writeFile(path.join(publicRoot, 'product.png'), png);
  await fs.writeFile(path.join(publicRoot, 'kyc.png'), png);
  await fs.writeFile(path.join(publicRoot, 'chats', 'hidden.png'), png);
  const oldFind = prisma.sellerDocument.findFirst;
  (prisma.sellerDocument.findFirst as any) = async ({ where }: any) =>
    where.OR.some((clause: any) => clause.fileName === 'kyc.png') ? { id: 'doc' } : null;
  try {
    const server = app(publicRoot);
    assert.equal((await request(server).get('/uploads/product.png')).status, 200);
    assert.equal((await request(server).get('/uploads/kyc.png')).status, 404);
    assert.equal((await request(server).get('/uploads/chats/hidden.png')).status, 404);
    assert.notEqual((await request(server).get('/uploads/%2e%2e%2fkyc.png')).status, 200);
  } finally {
    (prisma.sellerDocument.findFirst as any) = oldFind;
    await fs.rm(publicRoot, { recursive: true, force: true });
  }
});

test('chat and return images require account ownership or admin role', async () => {
  const chatFile = path.join(privateChatDir, 'launch-security.png');
  const returnFile = path.join(privateReturnsDir, 'buyer-1', 'launch-security.png');
  await fs.mkdir(path.dirname(chatFile), { recursive: true });
  await fs.mkdir(path.dirname(returnFile), { recursive: true });
  await fs.writeFile(chatFile, png);
  await fs.writeFile(returnFile, png);
  const oldUser = prisma.user.findUnique;
  const oldAttachment = prisma.chatMessageAttachment.findFirst;
  const oldPhoto = prisma.returnPhoto.findFirst;
  (prisma.user.findUnique as any) = async ({ where }: any) => ({ role: where.id === 'admin-1' ? 'ADMIN' : 'BUYER' });
  (prisma.chatMessageAttachment.findFirst as any) = async () => ({ url: '/private-files/chats/launch-security.png', message: { thread: { userId: 'buyer-1', sellerId: null, deletedAt: null } } });
  (prisma.returnPhoto.findFirst as any) = async () => ({ returnRequest: { userId: 'buyer-1' } });
  try {
    const server = app(path.join(process.cwd(), 'uploads'));
    assert.equal((await request(server).get('/private-files/chats/launch-security.png')).status, 401);
    assert.equal((await request(server).get('/private-files/chats/launch-security.png').set('Authorization', token('buyer-1'))).status, 200);
    assert.equal((await request(server).get('/private-files/chats/launch-security.png').set('Authorization', token('buyer-2'))).status, 404);
    assert.equal((await request(server).get('/private-files/chats/launch-security.png').set('Authorization', token('admin-1'))).status, 200);
    (prisma.chatMessageAttachment.findFirst as any) = async () => ({ url: '/private-files/chats/launch-security.png', message: { thread: { userId: 'buyer-1', sellerId: 'seller-1', deletedAt: null } } });
    assert.equal((await request(server).get('/private-files/chats/launch-security.png').set('Authorization', token('seller-1'))).status, 200);
    assert.equal((await request(server).get('/private-files/chats/launch-security.png').set('Authorization', token('seller-2'))).status, 404);
    assert.equal((await request(server).get('/private-files/returns/buyer-1/launch-security.png').set('Authorization', token('buyer-1'))).status, 200);
    assert.equal((await request(server).get('/private-files/returns/buyer-1/launch-security.png').set('Authorization', token('buyer-2'))).status, 404);
    assert.equal((await request(server).get('/private-files/returns/buyer-1/launch-security.png').set('Authorization', token('admin-1'))).status, 200);
    assert.notEqual((await request(server).get('/private-files/returns/buyer-1/%2e%2e%2flaunch-security.png').set('Authorization', token('buyer-1'))).status, 200);
  } finally {
    (prisma.user.findUnique as any) = oldUser;
    (prisma.chatMessageAttachment.findFirst as any) = oldAttachment;
    (prisma.returnPhoto.findFirst as any) = oldPhoto;
    await Promise.all([fs.unlink(chatFile), fs.unlink(returnFile)]);
  }
});

test('operational POST routes reject anonymous, buyer and seller; admin can run verified sync', async () => {
  const oldUser = prisma.user.findUnique;
  const oldSync = shipmentService.syncByShipmentId;
  const oldActive = cdekWebhookService.syncCdekStatusesForActiveOrders;
  let calls = 0;
  (prisma.user.findUnique as any) = async ({ where }: any) => ({ role: where.id === 'admin-1' ? 'ADMIN' : where.id === 'seller-1' ? 'SELLER' : 'BUYER', sellerProfile: where.id === 'seller-1' ? { id: 'p', status: 'APPROVED' } : null });
  (shipmentService.syncByShipmentId as any) = async () => { calls++; return { shipment: { id: 's', status: 'CREATED', statusRaw: {} }, snapshot: { trackingNumber: null, status: 'CREATED' } }; };
  (cdekWebhookService.syncCdekStatusesForActiveOrders as any) = async () => { calls++; return { synced: 0 }; };
  try {
    const server = app(path.join(process.cwd(), 'uploads'));
    for (const route of ['/shipments/s/sync', '/internal/cdek/orders/sync-active']) {
      assert.equal((await request(server).post(route)).status, 401);
      assert.equal((await request(server).post(route).set('Authorization', token('buyer-1'))).status, 403);
      assert.equal((await request(server).post(route).set('Authorization', token('seller-1'))).status, 403);
      assert.equal((await request(server).post(route).set('Authorization', token('admin-1'))).status, 200);
    }
    assert.equal(calls, 2);
  } finally {
    (prisma.user.findUnique as any) = oldUser;
    (shipmentService.syncByShipmentId as any) = oldSync;
    (cdekWebhookService.syncCdekStatusesForActiveOrders as any) = oldActive;
  }
});
