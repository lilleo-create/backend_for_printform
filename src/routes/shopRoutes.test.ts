import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { shopRoutes } from './shopRoutes';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const tokenFor = (userId: string, role: 'BUYER' | 'SELLER' | 'ADMIN' = 'SELLER') =>
  jwt.sign({ userId, role, scope: 'access' }, env.jwtSecret);

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/shops', shopRoutes);
  return app;
};

test('GET /shops/me returns explicit STORE_NOT_CREATED when seller profile is missing', async () => {
  (prisma.user.findUnique as any) = async ({ where }: any) => {
    if (where.id === 'seller-1') {
      return { id: 'seller-1', role: 'SELLER', sellerProfile: null };
    }
    return null;
  };

  const app = buildApp();
  const response = await request(app)
    .get('/shops/me')
    .set('Authorization', `Bearer ${tokenFor('seller-1')}`);

  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, 'STORE_NOT_CREATED');
});

test('GET /shops/:shopRef resolves store by slug and returns public shop', async () => {
  (prisma.user.findUnique as any) = async ({ where }: any) => {
    if (where.id === 'magazin-vasya') {
      return null;
    }
    return null;
  };
  (prisma.user.findMany as any) = async () => ([
    {
      id: 'seller-42',
      name: 'Вася',
      sellerProfile: {
        status: 'APPROVED',
        storeName: 'Магазин Вася',
        sellerType: 'IP',
        legalType: null,
        phone: '+79990000000',
        city: 'Москва',
        referenceCategory: 'Сувениры'
      }
    }
  ]);
  (prisma.product.aggregate as any) = async () => ({
    _avg: { ratingAvg: 4.5 },
    _sum: { ratingCount: 12 }
  });

  const app = buildApp();
  const response = await request(app).get('/shops/magazin-vasya');

  assert.equal(response.status, 200);
  assert.equal(response.body.data.id, 'seller-42');
  assert.equal(response.body.data.addressSlug, 'magazin-vasya');
});

test('GET /shops/:shopRef/products returns approved products for resolved shop', async () => {
  (prisma.user.findUnique as any) = async () => null;
  (prisma.user.findMany as any) = async () => ([
    {
      id: 'seller-77',
      name: 'Store owner',
      sellerProfile: {
        status: 'APPROVED',
        storeName: 'Store owner',
        sellerType: 'IP',
        legalType: null,
        phone: '+70000000000',
        city: 'Kazan',
        referenceCategory: null
      }
    }
  ]);
  (prisma.product.findMany as any) = async ({ where }: any) => ([
    { id: 'p-1', sellerId: where.sellerId, moderationStatus: where.moderationStatus }
  ]);

  const app = buildApp();
  const response = await request(app).get('/shops/store-owner/products');

  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);
  assert.equal(response.body.data[0].sellerId, 'seller-77');
  assert.equal(response.body.data[0].moderationStatus, 'APPROVED');
});


test('GET /shops/:shopRef returns STORE_NOT_PUBLIC for unpublished store in public flow', async () => {
  (prisma.user.findUnique as any) = async () => null;
  (prisma.user.findMany as any) = async () => ([
    {
      id: 'seller-80',
      name: 'Hidden seller',
      sellerProfile: {
        status: 'ONBOARDING',
        storeName: 'Hidden store',
        sellerType: 'IP',
        legalType: null,
        phone: '+70000000001',
        city: 'Kazan',
        referenceCategory: null
      }
    }
  ]);

  const app = buildApp();
  const response = await request(app).get('/shops/hidden-store');

  assert.equal(response.status, 403);
  assert.equal(response.body.error.code, 'STORE_NOT_PUBLIC');
});

test('GET /shops/me returns owner shop even when store is not published', async () => {
  (prisma.user.findUnique as any) = async ({ where }: any) => {
    if (where.id === 'seller-2') {
      return {
        id: 'seller-2',
        name: 'Owner',
        role: 'SELLER',
        sellerProfile: {
          status: 'ONBOARDING',
          storeName: 'Owner private store',
          sellerType: 'IP',
          legalType: null,
          phone: '+79991112233',
          city: 'Moscow',
          referenceCategory: 'Accessories'
        }
      };
    }
    return null;
  };
  (prisma.product.aggregate as any) = async () => ({
    _avg: { ratingAvg: null },
    _sum: { ratingCount: null }
  });

  const app = buildApp();
  const response = await request(app)
    .get('/shops/me')
    .set('Authorization', `Bearer ${tokenFor('seller-2')}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.data.id, 'seller-2');
  assert.equal(response.body.data.legalInfo.status, 'ONBOARDING');
  assert.equal(response.body.data.isPublished, false);
});
