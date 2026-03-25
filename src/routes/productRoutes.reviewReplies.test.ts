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

test('seller-owner can create review reply', async () => {
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
          authorType: data.authorType,
          text: data.text,
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
  assert.equal(response.body.data.author.displayName, 'Owner Shop');
});

test('another seller cannot create review reply', async () => {
  (prisma.user.findUnique as any) = async ({ where }: any) => {
    if (where.id === 'seller-2') {
      return { role: 'SELLER', sellerProfile: { id: 'sp-2', status: 'APPROVED' } };
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
        create: async () => {
          throw new Error('should not be called');
        }
      }
    });

  const app = buildApp();
  const response = await request(app)
    .post('/products/reviews/review-1/replies')
    .set('Authorization', `Bearer ${tokenFor('seller-2')}`)
    .send({ text: 'Чужой ответ' });

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'FORBIDDEN');
});

test('unauthenticated user cannot create review reply', async () => {
  const app = buildApp();
  const response = await request(app).post('/products/reviews/review-1/replies').send({ text: 'Без токена' });

  assert.equal(response.status, 401);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
});
