import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { authRoutes } from './authRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { userRepository } from '../repositories/userRepository';
import { deviceTrustService } from '../services/deviceTrustService';
import { authService } from '../services/authService';
import { env } from '../config/env';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/auth', authRoutes);
  app.use(errorHandler);
  return app;
};

const originalTrustedDeviceFlag = env.authTrustedDeviceEnforced;

const baseUser = {
  id: 'user-1',
  role: 'BUYER' as const,
  name: 'Test',
  fullName: 'Test User',
  email: 'test@example.com',
  phone: '+79991234567',
  address: null,
  phoneVerifiedAt: new Date('2026-03-22T00:00:00.000Z'),
  passwordHash: 'hashed-password'
};

test.afterEach(() => {
  env.authTrustedDeviceEnforced = originalTrustedDeviceFlag;
});

test('POST /auth/login returns 400 with friendly message for invalid credentials and does not issue session cookies', async () => {
  env.authTrustedDeviceEnforced = false;
  let cleanupCalls = 0;
  let findTrustedCalls = 0;
  (deviceTrustService.cleanupExpired as any) = async () => {
    cleanupCalls += 1;
  };
  (deviceTrustService.findTrustedDeviceForRequest as any) = async () => {
    findTrustedCalls += 1;
    return null;
  };
  (authService.login as any) = async () => { throw new Error('INVALID_CREDENTIALS'); };

  const response = await request(buildApp())
    .post('/auth/login')
    .send({ phone: '+7 (999) 123-45-67', password: 'secret123' });

  assert.equal(response.status, 400);
  assert.deepEqual(response.body, {
    error: {
      code: 'INVALID_CREDENTIALS',
      message: 'Неверный номер телефона или пароль'
    }
  });
  assert.equal(cleanupCalls, 1);
  assert.equal(findTrustedCalls, 0);
  assert.equal(response.headers['set-cookie']?.some((value: string) => value.includes(`${env.authRefreshCookieName}=`)), true);
});

test('POST /auth/login accepts phone sent in email field and authorizes without device challenge when trusted-device flow is disabled', async () => {
  env.authTrustedDeviceEnforced = false;
  let issueTokensCalls = 0;
  let loginCalls = 0;
  (deviceTrustService.cleanupExpired as any) = async () => {};
  (deviceTrustService.findTrustedDeviceForRequest as any) = async () => {
    throw new Error('trusted device lookup should not run');
  };
  (authService.login as any) = async ({ phone }: { phone: string }) => {
    loginCalls += 1;
    assert.equal(phone, '+79991234567');
    return { user: baseUser };
  };
  (authService.issueTokens as any) = async () => {
    issueTokensCalls += 1;
    return { accessToken: 'access-token', refreshToken: 'refresh-token', refreshExpiresAt: new Date() };
  };

  const response = await request(buildApp())
    .post('/auth/login')
    .send({ email: '+7 (999) 123-45-67', password: 'secret123' });

  assert.equal(response.status, 200);
  assert.equal(loginCalls, 1);
  assert.equal(issueTokensCalls, 1);
  assert.equal(response.body.data.accessToken, 'access-token');
  assert.equal(response.body.data.session.trustedDevice, false);
});

test('POST /auth/login returns separate device verification state without refresh-session cookies when trusted-device flow is enabled', async () => {
  env.authTrustedDeviceEnforced = true;
  let trustedLookupCalls = 0;
  (deviceTrustService.cleanupExpired as any) = async () => {};
  (deviceTrustService.findTrustedDeviceForRequest as any) = async () => {
    trustedLookupCalls += 1;
    return null;
  };
  (authService.login as any) = async ({ phone }: { phone: string }) => {
    assert.equal(phone, '+79991234567');
    return { user: baseUser };
  };
  (authService.issueTokens as any) = async () => {
    throw new Error('issueTokens should not run for a new device challenge');
  };

  const response = await request(buildApp())
    .post('/auth/login')
    .send({ phone: '+7 (999) 123-45-67', password: 'secret123' });

  assert.equal(response.status, 403);
  assert.equal(trustedLookupCalls, 1);
  assert.equal(response.body.error.code, 'DEVICE_VERIFICATION_REQUIRED');
  assert.equal(response.body.requiresDeviceVerification, true);
  assert.equal(response.body.verification.reason, 'new_device');
  assert.equal(response.headers['set-cookie']?.some((value: string) => value.includes(`${env.authRefreshCookieName}=`)), true);
});
