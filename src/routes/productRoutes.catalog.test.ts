import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { productRoutes } from './productRoutes';
import { productUseCases } from '../usecases/productUseCases';
import { prisma } from '../lib/prisma';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/products', productRoutes);
  return app;
};

const originalList = productUseCases.list;
const originalFindMany = prisma.product.findMany;
const originalAggregate = prisma.product.aggregate;

test.afterEach(() => {
  productUseCases.list = originalList;
  (prisma.product.findMany as any) = originalFindMany;
  (prisma.product.aggregate as any) = originalAggregate;
});

test('GET /products returns pagination meta and supports popularity sort params', async () => {
  let received: any = null;
  productUseCases.list = (async (filters: any) => {
    received = filters;
    return {
      items: [{ id: 'p-1' }],
      meta: { total: 1, page: 1, limit: 12, hasMore: false, nextPage: null }
    };
  }) as any;

  const app = buildApp();
  const response = await request(app)
    .get('/products')
    .query({ q: 'PLA', sort: 'popularity', available: 'true', page: 1, limit: 12 })
    .expect(200);

  assert.equal(received.sort, 'popularity');
  assert.equal(received.available, true);
  assert.equal(response.body.meta.total, 1);
  assert.equal(Array.isArray(response.body.data), true);
});

test('GET /products/filters/meta returns categories/materials/price range', async () => {
  (prisma.product.findMany as any) = async ({ distinct }: any) => {
    if (distinct.includes('category')) {
      return [{ category: 'Figurines' }];
    }
    return [{ material: 'PLA' }];
  };
  (prisma.product.aggregate as any) = async () => ({
    _min: { price: 100 },
    _max: { price: 1000 }
  });

  const app = buildApp();
  const response = await request(app).get('/products/filters/meta').expect(200);

  assert.deepEqual(response.body.data.categories, ['Figurines']);
  assert.deepEqual(response.body.data.materials, ['PLA']);
  assert.equal(response.body.data.price.min, 100);
  assert.equal(response.body.data.price.max, 1000);
});
