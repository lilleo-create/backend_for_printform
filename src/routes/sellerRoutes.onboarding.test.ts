import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sellerRoutes } from './sellerRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/seller', sellerRoutes);
  app.use(errorHandler);
  return app;
};

const userId = 'seller-user-1';
const accessToken = jwt.sign({ userId, role: 'BUYER', scope: 'access' }, env.jwtSecret);

const originalFindUnique = prisma.user.findUnique;
const originalUpdate = prisma.user.update;
const originalSellerProfileFindUnique = prisma.sellerProfile.findUnique;
const originalSellerKycFindFirst = prisma.sellerKycSubmission.findFirst;

type OnboardingUpdateArgs = {
  where: { id: string };
  data: {
    name: string;
    phone: string;
    role: string;
    sellerProfile: {
      upsert: {
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      };
    };
  };
};

let capturedUpdateArgs: OnboardingUpdateArgs | null = null;

const installPrismaMocks = () => {
  capturedUpdateArgs = null;

  (prisma.user.findUnique as unknown as (args: any) => Promise<any>) = async (args: any) => {
    if (args?.select?.sellerProfile) {
      return { role: 'BUYER', sellerProfile: null };
    }

    if (args?.select?.phoneVerifiedAt) {
      return {
        phoneVerifiedAt: new Date('2026-03-22T00:00:00.000Z'),
        phone: '+79991234567',
        email: 'seller@example.com'
      };
    }

    throw new Error(`Unexpected prisma.user.findUnique call: ${JSON.stringify(args)}`);
  };

  (prisma.user.update as unknown as (args: OnboardingUpdateArgs) => Promise<any>) = async (args) => {
    capturedUpdateArgs = args;
    return {
      id: args.where.id,
      name: args.data.name,
      email: 'seller@example.com',
      phone: args.data.phone,
      role: args.data.role
    };
  };

  (prisma.sellerProfile.findUnique as unknown as (args: any) => Promise<any>) = async () => null;
  (prisma.sellerKycSubmission.findFirst as unknown as (args: any) => Promise<any>) = async () => null;
};

test.beforeEach(() => {
  installPrismaMocks();
});

test.after(() => {
  (prisma.user.findUnique as any) = originalFindUnique;
  (prisma.user.update as any) = originalUpdate;
  (prisma.sellerProfile.findUnique as any) = originalSellerProfileFindUnique;
  (prisma.sellerKycSubmission.findFirst as any) = originalSellerKycFindFirst;
});

test('POST /seller/onboarding maps frontend status to sellerType and accepts empty referenceCategory', async () => {
  const response = await request(buildApp())
    .post('/seller/onboarding')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: 'Свтеиков Леонид Андреевич',
      phone: '+79778117527',
      email: 'LaggerFint@yandex.ru',
      status: 'ИП',
      city: 'Москва',
      referenceCategory: ''
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.sellerType, 'IP');
  assert.equal(capturedUpdateArgs?.data.sellerProfile.upsert.create.sellerType, 'IP');
  assert.equal(capturedUpdateArgs?.data.sellerProfile.upsert.create.legalType, 'ИП');
  assert.equal(capturedUpdateArgs?.data.sellerProfile.upsert.create.referenceCategory, null);
  assert.equal('catalogPosition' in (capturedUpdateArgs?.data.sellerProfile.upsert.create ?? {}), false);
  assert.equal(capturedUpdateArgs?.data.phone, '+79991234567');
});

test('POST /seller/onboarding still supports legacy sellerType payloads', async () => {
  const response = await request(buildApp())
    .post('/seller/onboarding')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: 'Иван Петров',
      phone: '+79990000000',
      email: 'seller@example.com',
      sellerType: 'SELF_EMPLOYED',
      city: 'Казань'
    });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.sellerType, 'SELF_EMPLOYED');
  assert.equal(capturedUpdateArgs?.data.sellerProfile.upsert.create.sellerType, 'SELF_EMPLOYED');
  assert.equal(capturedUpdateArgs?.data.sellerProfile.upsert.create.legalType, 'Самозанятый');
  assert.equal('catalogPosition' in (capturedUpdateArgs?.data.sellerProfile.upsert.create ?? {}), false);
});

test('POST /seller/onboarding returns business validation message when status and sellerType conflict', async () => {
  const response = await request(buildApp())
    .post('/seller/onboarding')
    .set('Authorization', `Bearer ${accessToken}`)
    .send({
      name: 'Иван Петров',
      phone: '+79990000000',
      email: 'seller@example.com',
      sellerType: 'LLC',
      status: 'ИП',
      city: 'Казань'
    });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: 'ONBOARDING_VALIDATION_ERROR',
      message: 'Ошибка валидации данных',
      issues: [
        {
          path: 'status',
          message: 'Поля status и sellerType передают один и тот же тип продавца и не должны конфликтовать.'
        }
      ]
    }
  });
});


test('POST /seller/onboarding keeps ADMIN role while enabling seller profile', async () => {
  const adminToken = jwt.sign({ userId, role: 'ADMIN', scope: 'access' }, env.jwtSecret);

  (prisma.user.findUnique as unknown as (args: any) => Promise<any>) = async (args: any) => {
    if (args?.select?.sellerProfile) {
      return { role: 'ADMIN', sellerProfile: null };
    }

    if (args?.select?.phoneVerifiedAt) {
      return {
        phoneVerifiedAt: new Date('2026-03-22T00:00:00.000Z'),
        phone: '+79991234567',
        email: 'seller@example.com'
      };
    }

    throw new Error(`Unexpected prisma.user.findUnique call: ${JSON.stringify(args)}`);
  };

  const response = await request(buildApp())
    .post('/seller/onboarding')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({
      name: 'Админ Продавец',
      phone: '+79990000000',
      email: 'admin-seller@example.com',
      sellerType: 'IP',
      city: 'Москва'
    });

  assert.equal(response.status, 200);
  assert.equal(capturedUpdateArgs?.data.role, 'ADMIN');
  assert.equal(response.body.data.role, 'ADMIN');
  assert.equal(response.body.data.capabilities.isAdmin, true);
  assert.equal(response.body.data.capabilities.isSeller, true);
});


test('GET /seller/context returns profile.sellerType in seller context payload', async () => {
  (prisma.sellerProfile.findUnique as unknown as (args: any) => Promise<any>) = async (args: any) => {
    assert.deepEqual(args, { where: { userId } });
    return {
      id: 'profile-1',
      userId,
      sellerType: 'IP',
      legalType: 'ИП',
      displayName: 'Мой магазин',
      storeName: 'Мой магазин',
      city: 'Москва',
      referenceCategory: null,
      catalogPosition: null,
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z')
    };
  };

  let findFirstCall = 0;
  (prisma.sellerKycSubmission.findFirst as unknown as (args: any) => Promise<any>) = async (args: any) => {
    findFirstCall += 1;
    if (findFirstCall === 1) {
      assert.equal(args.where.userId, userId);
      assert.deepEqual(args.orderBy, { createdAt: 'desc' });
      assert.deepEqual(args.include, { documents: true });
      return {
        id: 'kyc-1',
        userId,
        status: 'PENDING',
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
        documents: []
      };
    }

    assert.deepEqual(args.where, { userId, status: 'APPROVED' });
    assert.deepEqual(args.orderBy, { reviewedAt: 'desc' });
    return null;
  };

  const response = await request(buildApp())
    .get('/seller/context')
    .set('Authorization', `Bearer ${accessToken}`);

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    data: {
      isSeller: true,
      profile: {
        id: 'profile-1',
        userId,
        sellerType: 'IP',
        legalType: 'ИП',
        displayName: 'Мой магазин',
        storeName: 'Мой магазин',
        city: 'Москва',
        referenceCategory: null,
        catalogPosition: null,
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z'
      },
      kyc: {
        id: 'kyc-1',
        userId,
        status: 'PENDING',
        createdAt: '2026-03-22T00:00:00.000Z',
        updatedAt: '2026-03-22T00:00:00.000Z',
        documents: []
      },
      canSell: false
    }
  });
});


test('GET /seller/context keeps seller access for admin with seller profile', async () => {
  const adminToken = jwt.sign({ userId, role: 'ADMIN', scope: 'access' }, env.jwtSecret);

  (prisma.user.findUnique as unknown as (args: any) => Promise<any>) = async (args: any) => {
    if (args?.select?.sellerProfile) {
      return { role: 'ADMIN', sellerProfile: { id: 'profile-1', status: 'APPROVED' } };
    }

    throw new Error(`Unexpected prisma.user.findUnique call: ${JSON.stringify(args)}`);
  };

  (prisma.sellerProfile.findUnique as unknown as (args: any) => Promise<any>) = async (args: any) => {
    assert.deepEqual(args, { where: { userId } });
    return {
      id: 'profile-1',
      userId,
      sellerType: 'IP',
      legalType: 'ИП',
      displayName: 'Admin seller shop',
      storeName: 'Admin seller shop',
      city: 'Москва',
      referenceCategory: null,
      catalogPosition: null,
      status: 'APPROVED',
      createdAt: new Date('2026-03-22T00:00:00.000Z'),
      updatedAt: new Date('2026-03-22T00:00:00.000Z')
    };
  };

  let findFirstCall = 0;
  (prisma.sellerKycSubmission.findFirst as unknown as (args: any) => Promise<any>) = async () => {
    findFirstCall += 1;
    if (findFirstCall === 1) {
      return {
        id: 'kyc-1',
        userId,
        status: 'APPROVED',
        createdAt: new Date('2026-03-22T00:00:00.000Z'),
        updatedAt: new Date('2026-03-22T00:00:00.000Z'),
        documents: []
      };
    }

    return {
      id: 'kyc-1',
      userId,
      status: 'APPROVED',
      reviewedAt: new Date('2026-03-22T00:00:00.000Z')
    };
  };

  const response = await request(buildApp())
    .get('/seller/context')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(response.status, 200);
  assert.equal(response.body.data.isSeller, true);
  assert.equal(response.body.data.profile.id, 'profile-1');
  assert.equal(response.body.data.canSell, true);
});

test('GET /seller/context does not grant seller access to admin without seller profile', async () => {
  const adminToken = jwt.sign({ userId, role: 'ADMIN', scope: 'access' }, env.jwtSecret);

  (prisma.user.findUnique as unknown as (args: any) => Promise<any>) = async (args: any) => {
    if (args?.select?.sellerProfile) {
      return { role: 'ADMIN', sellerProfile: null };
    }

    throw new Error(`Unexpected prisma.user.findUnique call: ${JSON.stringify(args)}`);
  };

  (prisma.sellerProfile.findUnique as unknown as () => Promise<any>) = async () => null;
  (prisma.sellerKycSubmission.findFirst as unknown as () => Promise<any>) = async () => null;

  const response = await request(buildApp())
    .get('/seller/kyc/me')
    .set('Authorization', `Bearer ${adminToken}`);

  assert.equal(response.status, 403);
  assert.deepEqual(response.body, { error: { code: 'FORBIDDEN', message: 'Seller only' } });
});
