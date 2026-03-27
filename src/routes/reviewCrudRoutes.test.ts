import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { reviewCrudRoutes, reviewReplyCrudRoutes } from './reviewCrudRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { env } from '../config/env';
import { reviewService } from '../services/reviewService';
import { prisma } from '../lib/prisma';

const tokenFor = (userId: string, role: 'BUYER' | 'SELLER' | 'ADMIN' = 'SELLER') =>
  jwt.sign({ userId, role, scope: 'access' }, env.jwtSecret);

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/reviews', reviewCrudRoutes);
  app.use('/reviews/replies', reviewReplyCrudRoutes);
  app.use(errorHandler);
  return app;
};

const originalUpdateReply = reviewService.updateReply;
const originalDeleteReply = reviewService.deleteReply;
const originalUserFindUnique = prisma.user.findUnique;

test.afterEach(() => {
  reviewService.updateReply = originalUpdateReply;
  reviewService.deleteReply = originalDeleteReply;
  (prisma.user.findUnique as any) = originalUserFindUnique;
});

test('PATCH /reviews/replies/:replyId updates reply', async () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'SELLER', sellerProfile: { id: 'sp-1', status: 'APPROVED' } });
  reviewService.updateReply = async (replyId: string, actorId: string, text: string) => ({
    id: replyId,
    authorId: actorId,
    text
  } as any);

  const app = buildApp();
  const response = await request(app)
    .patch('/reviews/replies/reply-1')
    .set('Authorization', `Bearer ${tokenFor('seller-1')}`)
    .send({ text: 'Обновлённый текст ответа' });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.id, 'reply-1');
  assert.equal(response.body.data.text, 'Обновлённый текст ответа');
});

test('DELETE /reviews/replies/:replyId deletes reply', async () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'SELLER', sellerProfile: { id: 'sp-1', status: 'APPROVED' } });
  reviewService.deleteReply = async (replyId: string) => ({ id: replyId, deleted: true });

  const app = buildApp();
  const response = await request(app)
    .delete('/reviews/replies/reply-1')
    .set('Authorization', `Bearer ${tokenFor('seller-1')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.id, 'reply-1');
  assert.equal(response.body.data.deleted, true);
});
