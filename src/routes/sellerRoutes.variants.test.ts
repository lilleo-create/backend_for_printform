import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sellerRoutes } from './sellerRoutes';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { productUseCases } from '../usecases/productUseCases';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/seller', sellerRoutes);
  return app;
};

const tokenFor = (userId: string, role: 'SELLER' | 'ADMIN' = 'SELLER') => jwt.sign({ userId, role, scope: 'access' }, env.jwtSecret);

const mockSellerAccess = () => {
  (prisma.user.findUnique as any) = async () => ({ role: 'SELLER', sellerProfile: { id: 'sp-1', status: 'PENDING' } });
  (prisma.sellerKycSubmission.findFirst as any) = async () => ({ id: 'kyc-1', status: 'APPROVED' });
};

test('create variant without sku succeeds', async () => {
  mockSellerAccess();

  (productUseCases.getSellerProductWithVariants as any) = async () => ({
    id: 'prod-1',
    title: 'Product',
    category: 'Category',
    price: 1000,
    currency: 'RUB',
    description: 'Long enough description',
    descriptionShort: 'Short description',
    descriptionFull: 'Long enough full description',
    material: 'PLA',
    technology: 'FDM',
    productionTimeHours: 24,
    color: 'Black',
    image: '/uploads/base.jpg',
    imageUrls: ['/uploads/base.jpg'],
    videoUrls: []
  });

  (productUseCases.createVariant as any) = async (_masterProductId: string, _sellerId: string, data: any) => ({
    id: 'variant-1',
    ...data
  });

  const app = buildApp();
  const auth = `Bearer ${tokenFor('seller-1')}`;

  const response = await request(app)
    .post('/seller/products/prod-1/variants')
    .set('Authorization', auth)
    .send({
      color: 'White',
      variantLabel: 'XL'
    });

  assert.equal(response.status, 201);
  assert.ok(typeof response.body?.data?.sku === 'string');
  assert.match(response.body?.data?.sku ?? '', /^SKU-/);
});

test('update variant without sku succeeds', async () => {
  mockSellerAccess();

  (productUseCases.updateVariant as any) = async (
    _masterProductId: string,
    variantId: string,
    _sellerId: string,
    data: any
  ) => ({
    id: variantId,
    ...data
  });

  const app = buildApp();
  const auth = `Bearer ${tokenFor('seller-1')}`;

  const response = await request(app)
    .put('/seller/products/prod-1/variants/variant-1')
    .set('Authorization', auth)
    .send({
      color: 'Graphite'
    });

  assert.equal(response.status, 200);
  assert.equal(response.body?.data?.id, 'variant-1');
  assert.equal(response.body?.data?.color, 'Graphite');
});

test('list variants route returns variants payload', async () => {
  mockSellerAccess();
  (productUseCases.getSellerProductWithVariants as any) = async () => ({
    id: 'prod-1',
    variantGroup: { id: 'group-1', total: 2, activeVariantId: 'prod-1' },
    variants: [{ id: 'prod-1', sku: 'SKU-1' }, { id: 'variant-2', sku: 'SKU-2' }]
  });

  const app = buildApp();
  const response = await request(app)
    .get('/seller/products/prod-1/variants')
    .set('Authorization', `Bearer ${tokenFor('seller-1')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body?.data?.productId, 'prod-1');
  assert.equal(response.body?.data?.variants?.length, 2);
});

test('create variant accepts imageUrls list and maps media', async () => {
  mockSellerAccess();

  (productUseCases.getSellerProductWithVariants as any) = async () => ({
    id: 'prod-1',
    title: 'Product',
    category: 'Category',
    price: 1000,
    currency: 'RUB',
    description: 'Long enough description',
    descriptionShort: 'Short description',
    descriptionFull: 'Long enough full description',
    material: 'PLA',
    technology: 'FDM',
    productionTimeHours: 24,
    color: 'Black',
    image: '/uploads/base.jpg',
    imageUrls: ['/uploads/base.jpg'],
    videoUrls: []
  });

  (productUseCases.createVariant as any) = async (_masterProductId: string, _sellerId: string, data: any) => ({ id: 'v-2', ...data });

  const app = buildApp();
  const response = await request(app)
    .post('/seller/products/prod-1/variants')
    .set('Authorization', `Bearer ${tokenFor('seller-1')}`)
    .send({
      color: 'Red',
      imageUrls: ['/uploads/1.jpg', '/uploads/2.jpg']
    });

  assert.equal(response.status, 201);
  assert.deepEqual(response.body?.data?.imageUrls, ['/uploads/1.jpg', '/uploads/2.jpg']);
  assert.equal(response.body?.data?.image, '/uploads/1.jpg');
});
