import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { productRoutes } from './productRoutes';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { errorHandler } from '../middleware/errorHandler';

const tokenFor = (userId: string, role: 'BUYER' | 'SELLER' | 'ADMIN' = 'SELLER') =>
  jwt.sign({ userId, role, scope: 'access' }, env.jwtSecret);

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/products', productRoutes);
  app.use(errorHandler);
  return app;
};

const originalUserFindUnique = prisma.user.findUnique;
const originalTransaction = prisma.$transaction;

test.afterEach(() => {
  (prisma.user.findUnique as any) = originalUserFindUnique;
  (prisma.$transaction as any) = originalTransaction;
});

test('authorized seller can create review reply as SELLER with storeName', async () => {
  (prisma.user.findUnique as any) = async ({ where }: any) => {
    if (where.id === 'seller-1') {
      return { role: 'SELLER', sellerProfile: { id: 'sp-1', status: 'APPROVED' } };
    }
    return null;
  };

  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      review: {
        findUnique: async () => ({
          id: 'review-1',
          productId: 'product-1',
          product: { sellerId: 'seller-1' }
        })
      },
      reviewReply: {
        create: async ({ data }: any) => ({
          id: 'reply-1',
          reviewId: data.reviewId,
          authorId: 'seller-1',
          authorType: data.authorType,
          text: data.text,
          moderationStatus: data.moderationStatus,
          createdAt: new Date('2026-03-25T12:00:00.000Z'),
          updatedAt: new Date('2026-03-25T12:00:00.000Z'),
          author: { id: 'seller-1', name: 'Owner', sellerProfile: { storeName: 'Owner Shop' } }
        })
      }
    });

  const app = buildApp();
  const response = await request(app)
    .post('/products/reviews/review-1/replies')
    .set('Authorization', `Bearer ${tokenFor('seller-1')}`)
    .send({ text: 'Спасибо за отзыв!' });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.reviewId, 'review-1');
  assert.equal(response.body.data.authorType, 'SELLER');
  assert.equal(response.body.data.author.storeName, 'Owner Shop');
  assert.equal(response.body.data.author.nickname, 'Owner');
  assert.equal(response.body.data.author.displayName, 'Owner Shop');
  assert.equal(response.body.data.moderationStatus, 'PENDING');
  assert.equal(response.body.data.moderationStatusLabelRu, 'На модерации');
  assert.equal(response.body.data.isOwn, true);
  assert.equal(response.body.data.canEdit, true);
  assert.equal(response.body.data.canDelete, true);
});

test('authorized user can create review reply as BUYER with nickname', async () => {
  (prisma.user.findUnique as any) = async ({ where }: any) => {
    if (where.id === 'buyer-1') {
      return { role: 'BUYER', sellerProfile: null };
    }
    return null;
  };

  (prisma.$transaction as any) = async (cb: any) =>
    cb({
      review: {
        findUnique: async () => ({
          id: 'review-1',
          productId: 'product-1',
          product: { sellerId: 'seller-1' }
        })
      },
      reviewReply: {
        create: async ({ data }: any) => ({
          id: 'reply-2',
          reviewId: data.reviewId,
          authorId: 'buyer-1',
          authorType: data.authorType,
          text: data.text,
          moderationStatus: data.moderationStatus,
          createdAt: new Date('2026-03-25T12:00:00.000Z'),
          updatedAt: new Date('2026-03-25T12:00:00.000Z'),
          author: { id: 'buyer-1', name: 'Customer Nick', sellerProfile: null }
        })
      }
    });

  const app = buildApp();
  const response = await request(app)
    .post('/products/reviews/review-1/replies')
    .set('Authorization', `Bearer ${tokenFor('buyer-1', 'BUYER')}`)
    .send({ text: 'Ответ пользователя' });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.authorType, 'BUYER');
  assert.equal(response.body.data.author.nickname, 'Customer Nick');
  assert.equal(response.body.data.author.storeName, null);
  assert.equal(response.body.data.author.displayName, 'Customer Nick');
  assert.equal(response.body.data.moderationStatus, 'PENDING');
});

test('unauthenticated user cannot create review reply', async () => {
  const app = buildApp();
  const response = await request(app).post('/products/reviews/review-1/replies').send({ text: 'Без токена' });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
});
