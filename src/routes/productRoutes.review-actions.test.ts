import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

import { productRoutes } from './productRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { env } from '../config/env';
import { reviewService } from '../services/reviewService';
import { prisma } from '../lib/prisma';

const tokenFor = (userId: string, role: 'BUYER' | 'SELLER' | 'ADMIN' = 'BUYER') =>
  jwt.sign({ userId, role, scope: 'access' }, env.jwtSecret);

const originalUserFindUnique = prisma.user.findUnique;

test.afterEach(() => {
  (prisma.user.findUnique as any) = originalUserFindUnique;
});

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/products', productRoutes);
  app.use(errorHandler);
  return app;
};

test('review reaction wrong method returns JSON not HTML', async () => {
  const response = await request(buildApp())
    .post('/products/product-1/reviews/review-1/reaction')
    .send({ type: 'LIKE' });

  assert.equal(response.status, 404);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  assert.equal(response.body.error.code, 'ROUTE_NOT_FOUND');
  assert.equal(response.body.error.message, 'ROUTE_NOT_FOUND');
});

test('review reaction without auth returns JSON auth error', async () => {
  const response = await request(buildApp())
    .patch('/products/product-1/reviews/review-1/reaction')
    .send({ type: 'LIKE' });

  assert.equal(response.status, 401);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
  assert.equal(response.body.error.message, 'UNAUTHORIZED');
});

test('standalone reaction route without auth returns JSON auth error', async () => {
  const response = await request(buildApp())
    .patch('/products/reviews/review-1/reaction')
    .send({ type: 'DISLIKE' });

  assert.equal(response.status, 401);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
  assert.equal(response.body.error.message, 'UNAUTHORIZED');
});

test('review replies without auth returns JSON auth error', async () => {
  const response = await request(buildApp())
    .post('/products/product-1/reviews/review-1/replies')
    .send({ text: 'Спасибо за отзыв' });

  assert.equal(response.status, 401);
  assert.match(response.headers['content-type'] ?? '', /application\/json/);
  assert.equal(response.body.error.code, 'UNAUTHORIZED');
  assert.equal(response.body.error.message, 'UNAUTHORIZED');
});

test('review reaction accepts legacy field `reaction` and returns stable contract', async () => {
  const originalSetReaction = reviewService.setReaction;
  (prisma.user.findUnique as any) = async () => ({ role: 'BUYER', sellerProfile: null });
  (reviewService.setReaction as any) = async (_reviewId: string, _userId: string, reaction: string) => ({
    reviewId: 'review-1',
    currentUserReaction: reaction,
    reactions: { likes: 3, dislikes: 1 }
  });

  try {
    const response = await request(buildApp())
      .patch('/products/reviews/review-1/reaction')
      .set('Authorization', `Bearer ${tokenFor('buyer-1')}`)
      .send({ reaction: 'LIKE' });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.reviewId, 'review-1');
    assert.equal(response.body.data.currentUserReaction, 'LIKE');
    assert.deepEqual(response.body.data.reactions, { likes: 3, dislikes: 1 });
  } finally {
    (reviewService.setReaction as any) = originalSetReaction;
  }
});
