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
};

test.beforeEach(() => {
  installPrismaMocks();
});

test.after(() => {
  (prisma.user.findUnique as any) = originalFindUnique;
  (prisma.user.update as any) = originalUpdate;
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
