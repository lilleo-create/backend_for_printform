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
import { otpService } from '../services/otpService';
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

test('POST /auth/login starts existing OTP flow for a new device and returns challenge contract without issuing session tokens', async () => {
  env.authTrustedDeviceEnforced = true;
  let trustedLookupCalls = 0;
  let otpRequests = 0;
  (deviceTrustService.cleanupExpired as unknown as () => Promise<void>) = async () => {};
  (deviceTrustService.findTrustedDeviceForRequest as unknown as () => Promise<null>) = async () => {
    trustedLookupCalls += 1;
    return null;
  };
  (authService.login as unknown as (args: { phone: string }, password: string) => Promise<{ user: typeof baseUser }>) = async ({ phone }: { phone: string }) => {
    assert.equal(phone, '+79991234567');
    return { user: baseUser };
  };
  (authService.issueTokens as unknown as () => Promise<never>) = async () => {
    throw new Error('issueTokens should not run for a new device challenge');
  };
  (otpService.requestOtp as unknown as (payload: { phone: string; purpose: string }) => Promise<{ ok: true; data: { requestId: string; phone: string; provider: 'plusofon'; verificationType: 'call_to_auth'; callToAuthNumber: string | null } }>) = async (payload) => {
    otpRequests += 1;
    assert.equal(payload.phone, '+79991234567');
    assert.equal(payload.purpose, 'login_device');
    return { ok: true, data: { requestId: 'req-123', phone: '+79991234567', provider: 'plusofon', verificationType: 'call_to_auth', callToAuthNumber: '+78005553535' } };
  };

  const response = await request(buildApp())
    .post('/auth/login')
    .send({ phone: '+7 (999) 123-45-67', password: 'secret123' });

  assert.equal(response.status, 403);
  assert.equal(trustedLookupCalls, 1);
  assert.equal(otpRequests, 1);
  assert.equal(response.body.error.code, 'DEVICE_VERIFICATION_REQUIRED');
  assert.equal(response.body.requiresDeviceVerification, true);
  assert.equal(response.body.verificationMethod, 'existing_otp_flow');
  assert.equal(response.body.requestId, 'req-123');
  assert.equal(response.body.phone, '+79991234567');
  assert.equal(response.headers['set-cookie']?.some((value: string) => value.includes(`${env.authRefreshCookieName}=`)), true);
});

test('POST /auth/otp/verify completes login_device challenge via existing OTP endpoint and trusts device', async () => {
  const tempToken = authService.issueLoginDeviceOtpToken({ id: baseUser.id });
  let trustCalls = 0;
  let issueTokensCalls = 0;
  (otpService.verifyOtpByRequestId as unknown as (payload: { phone: string; requestId: string; purpose: string }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, '+7 (999) 123-45-67');
    assert.equal(payload.requestId, 'req-verified');
    assert.equal(payload.purpose, 'login_device');
    return { phone: '+79991234567' };
  };
  (userRepository.findById as unknown as (id: string) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (deviceTrustService.trustCurrentDevice as unknown as (userId: string) => Promise<{ device: { id: string }; token: string }>) = async (userId) => {
    trustCalls += 1;
    assert.equal(userId, baseUser.id);
    return { device: { id: 'trusted-1' }, token: 'trusted-token' };
  };
  (authService.issueTokens as unknown as () => Promise<{ accessToken: string; refreshToken: string; refreshExpiresAt: Date }>) = async () => {
    issueTokensCalls += 1;
    return { accessToken: 'access-token', refreshToken: 'refresh-token', refreshExpiresAt: new Date() };
  };

  const response = await request(buildApp())
    .post('/auth/otp/verify')
    .set('Authorization', `Bearer ${tempToken}`)
    .send({ phone: '+7 (999) 123-45-67', requestId: 'req-verified', purpose: 'login_device' });

  assert.equal(response.status, 200);
  assert.equal(trustCalls, 1);
  assert.equal(issueTokensCalls, 1);
  assert.equal(response.body.data.accessToken, 'access-token');
  assert.equal(response.body.data.session.trustedDevice, true);
  assert.equal(response.headers['set-cookie']?.some((value: string) => value.includes(`${env.trustedDeviceCookieName}=trusted-token`)), true);
});

test('POST /auth/login/device/verify accepts tempToken from body and completes device verification without explicit purpose', async () => {
  const tempToken = authService.issueLoginDeviceOtpToken({ id: baseUser.id });
  let trustCalls = 0;
  (otpService.verifyOtpByRequestId as unknown as (payload: { phone: string; requestId: string; purpose: string }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, '+7 (999) 123-45-67');
    assert.equal(payload.requestId, 'req-device-body');
    assert.equal(payload.purpose, 'login_device');
    return { phone: '+79991234567' };
  };
  (userRepository.findById as unknown as (id: string) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (deviceTrustService.trustCurrentDevice as unknown as (userId: string) => Promise<{ device: { id: string }; token: string }>) = async (userId) => {
    trustCalls += 1;
    assert.equal(userId, baseUser.id);
    return { device: { id: 'trusted-2' }, token: 'trusted-token-2' };
  };
  (authService.issueTokens as unknown as () => Promise<{ accessToken: string; refreshToken: string; refreshExpiresAt: Date }>) = async () => {
    return { accessToken: 'access-token-2', refreshToken: 'refresh-token-2', refreshExpiresAt: new Date() };
  };

  const response = await request(buildApp())
    .post('/auth/login/device/verify')
    .send({ phone: '+7 (999) 123-45-67', requestId: 'req-device-body', tempToken });

  assert.equal(response.status, 200);
  assert.equal(trustCalls, 1);
  assert.equal(response.body.data.accessToken, 'access-token-2');
  assert.equal(response.body.data.session.trustedDevice, true);
  assert.equal(response.headers['set-cookie']?.some((value: string) => value.includes(`${env.trustedDeviceCookieName}=trusted-token-2`)), true);
});


test('POST /auth/password-reset/request starts the existing OTP flow and returns reusable challenge contract', async () => {
  let otpRequests = 0;
  (userRepository.findByPhone as unknown as (phone: string) => Promise<typeof baseUser | null>) = async (phone) => {
    assert.equal(phone, '+79991234567');
    return baseUser;
  };
  (otpService.requestOtp as unknown as (payload: { phone: string; purpose: string }) => Promise<{ ok: true; data: { requestId: string; phone: string; provider: 'plusofon'; verificationType: 'call_to_auth'; callToAuthNumber: string | null } }>) = async (payload) => {
    otpRequests += 1;
    assert.equal(payload.phone, '+79991234567');
    assert.equal(payload.purpose, 'password_reset');
    return { ok: true, data: { requestId: 'reset-req-1', phone: '+79991234567', provider: 'plusofon', verificationType: 'call_to_auth', callToAuthNumber: '+78005553535' } };
  };

  const response = await request(buildApp())
    .post('/auth/password-reset/request')
    .send({ phone: '+7 (999) 123-45-67' });

  assert.equal(response.status, 200);
  assert.equal(otpRequests, 1);
  assert.equal(response.body.verificationMethod, 'existing_otp_flow');
  assert.equal(response.body.requestId, 'reset-req-1');
  assert.equal(response.body.phone, '+79991234567');
  assert.equal(typeof response.body.tempToken, 'string');
  assert.equal(response.body.requiresPasswordResetVerification, true);
});

test('POST /auth/password-reset/verify validates password reset via the existing OTP token flow', async () => {
  const tempToken = authService.issuePasswordResetOtpToken({ id: baseUser.id });
  (userRepository.findById as unknown as (id: string) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (otpService.verifyOtpByRequestId as unknown as (payload: { phone: string; requestId: string; purpose: string }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, '+7 (999) 123-45-67');
    assert.equal(payload.requestId, 'reset-req-verified');
    assert.equal(payload.purpose, 'password_reset');
    return { phone: '+79991234567' };
  };

  const response = await request(buildApp())
    .post('/auth/password-reset/verify')
    .set('Authorization', `Bearer ${tempToken}`)
    .send({ phone: '+7 (999) 123-45-67', requestId: 'reset-req-verified' });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.resetToken, 'string');
});

test('POST /auth/otp/verify infers password_reset purpose from tempToken when purpose is omitted', async () => {
  const tempToken = authService.issuePasswordResetOtpToken({ id: baseUser.id });
  (userRepository.findById as unknown as (id: string) => Promise<typeof baseUser | null>) = async (id) => {
    assert.equal(id, baseUser.id);
    return baseUser;
  };
  (otpService.verifyOtpByRequestId as unknown as (payload: { phone: string; requestId: string; purpose: string }) => Promise<{ phone: string }>) = async (payload) => {
    assert.equal(payload.phone, '+7 (999) 123-45-67');
    assert.equal(payload.requestId, 'reset-req-generic');
    assert.equal(payload.purpose, 'password_reset');
    return { phone: '+79991234567' };
  };

  const response = await request(buildApp())
    .post('/auth/otp/verify')
    .send({ phone: '+7 (999) 123-45-67', requestId: 'reset-req-generic', tempToken });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(typeof response.body.resetToken, 'string');
});
