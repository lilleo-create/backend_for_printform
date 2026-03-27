import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import { productRoutes } from './productRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { productUseCases } from '../usecases/productUseCases';
import { reviewService } from '../services/reviewService';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/products', productRoutes);
  app.use(errorHandler);
  return app;
};

const originalGetProduct = productUseCases.get;
const originalGetSellerSummary = reviewService.getSellerSummaryByProductId;

test.afterEach(() => {
  productUseCases.get = originalGetProduct;
  reviewService.getSellerSummaryByProductId = originalGetSellerSummary;
});

test('GET /products/:id/seller-summary returns safe seller summary payload for product page', async () => {
  productUseCases.get = async () => ({ id: 'product-1' } as any);
  reviewService.getSellerSummaryByProductId = async () => ({
    id: 'seller-1',
    storeTitle: 'Название магазина',
    sellerName: 'Имя продавца',
    rating: 4.8,
    productsCount: 12,
    storeAvailable: false
  });

  const app = buildApp();
  const response = await request(app).get('/products/product-1/seller-summary');

  assert.equal(response.status, 200);
  assert.equal(response.body.data.productId, 'product-1');
  assert.equal(response.body.data.seller.id, 'seller-1');
  assert.equal(response.body.data.seller.storeTitle, 'Название магазина');
  assert.equal(response.body.data.seller.sellerName, 'Имя продавца');
  assert.equal(response.body.data.seller.storeAvailable, false);
});
