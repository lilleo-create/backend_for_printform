import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';

import { productRoutes } from './productRoutes';
import { errorHandler } from '../middleware/errorHandler';

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
    .put('/products/product-1/reviews/review-1/reaction')
    .send({ type: 'LIKE' });

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
