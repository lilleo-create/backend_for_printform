import test from 'node:test';
import assert from 'node:assert/strict';
import { otpService } from './otpService';
import { plusofonService } from './plusofonService';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { smsProvider } from './smsProvider';

test('password reset and login device share phone quota without blocking a different phone', async () => {
  const originalCount = prisma.phoneOtp.count;
  const originalFindFirst = prisma.phoneOtp.findFirst;
  const originalCreate = prisma.phoneOtp.create;
  const originalUpdate = prisma.phoneOtp.update;
  const originalTransaction = prisma.$transaction;
  const originalProvider = plusofonService.requestCallToAuth;
  const queries: unknown[] = [];
  let providerCalls = 0;
  (prisma.phoneOtp.count as any) = async ({ where }: any) => {
    queries.push(where);
    return where.phone === '+79991111111' && !where.purpose ? 6 : 0;
  };
  (prisma.phoneOtp.findFirst as any) = async () => null;
  (prisma.phoneOtp.create as any) = async () => ({ id: 'otp-1' });
  (prisma.phoneOtp.update as any) = async () => ({ id: 'otp-1' });
  (prisma.$transaction as any) = async (callback: any) => callback({ phoneOtp: prisma.phoneOtp, $queryRaw: async () => [] });
  (plusofonService.requestCallToAuth as any) = async (phone: string) => {
    providerCalls++;
    return { requestId: 'request-1', verificationType: 'call_to_auth', callToAuthNumber: null, phone, raw: {} };
  };
  try {
    for (const purpose of ['password_reset', 'login_device'] as const) {
      const blocked = await otpService.requestOtp({ phone: '+7 (999) 111-11-11', purpose });
      assert.deepEqual(blocked, { ok: true, throttled: true });
    }
    assert.equal(providerCalls, 0);
    const allowed = await otpService.requestOtp({ phone: '+7 (999) 222-22-22', purpose: 'password_reset' });
    assert.equal(allowed.ok, true);
    assert.equal(providerCalls, 1);
    assert.ok(queries.some((where: any) => where.phone === '+79991111111' && !where.purpose));
  } finally {
    (prisma.phoneOtp.count as any) = originalCount;
    (prisma.phoneOtp.findFirst as any) = originalFindFirst;
    (prisma.phoneOtp.create as any) = originalCreate;
    (prisma.phoneOtp.update as any) = originalUpdate;
    (prisma.$transaction as any) = originalTransaction;
    (plusofonService.requestCallToAuth as any) = originalProvider;
  }
});

test('OTP mismatch log contains no phone or code', async () => {
  const originalFindFirst = prisma.phoneOtp.findFirst;
  const originalInfo = console.info;
  const logs: unknown[] = [];
  (prisma.phoneOtp.findFirst as any) = async () => ({ phone: '+79991111111', providerPayload: { callToAuthNumber: '+79993333333' } });
  console.info = (...args: unknown[]) => { logs.push(args); };
  try {
    await assert.rejects(
      otpService.verifyOtpByRequestId({ phone: '+79992222222', requestId: 'request-1', purpose: 'password_reset' }),
      /PHONE_MISMATCH/
    );
    const serialized = JSON.stringify(logs);
    assert.doesNotMatch(serialized, /7999\d{7}|123456|callToAuthNumber|incomingPhone/);
    assert.match(serialized, /PHONE_MISMATCH/);
  } finally {
    (prisma.phoneOtp.findFirst as any) = originalFindFirst;
    console.info = originalInfo;
  }
});

test('same-purpose quota and verification attempt limit remain enforced', async () => {
  const originalCount = prisma.phoneOtp.count;
  const originalFindFirst = prisma.phoneOtp.findFirst;
  const originalProvider = plusofonService.requestCallToAuth;
  const originalTransaction = prisma.$transaction;
  let providerCalls = 0;
  (prisma.phoneOtp.count as any) = async ({ where }: any) => where.purpose ? 3 : 3;
  (prisma.phoneOtp.findFirst as any) = async () => ({ attempts: env.otpMaxAttempts, maxAttempts: env.otpMaxAttempts });
  (prisma.$transaction as any) = async (callback: any) => callback({ phoneOtp: prisma.phoneOtp, $queryRaw: async () => [] });
  (plusofonService.requestCallToAuth as any) = async () => { providerCalls++; throw new Error('must not call provider'); };
  try {
    assert.deepEqual(await otpService.requestOtp({ phone: '+79991111111', purpose: 'password_reset' }), { ok: true, throttled: true });
    assert.equal(providerCalls, 0);
    await assert.rejects(otpService.verifyOtp({ phone: '+79991111111', code: '123456', purpose: 'buyer_change_phone' }), /OTP_TOO_MANY/);
  } finally {
    (prisma.phoneOtp.count as any) = originalCount;
    (prisma.phoneOtp.findFirst as any) = originalFindFirst;
    (plusofonService.requestCallToAuth as any) = originalProvider;
    (prisma.$transaction as any) = originalTransaction;
  }
});

test('development console delivery does not log phone or OTP code', async () => {
  if (env.smsProvider === 'twilio') return;
  const originalInfo = console.info;
  const logs: unknown[] = [];
  console.info = (...args: unknown[]) => { logs.push(args); };
  try {
    if (env.isProduction) {
      await assert.rejects(smsProvider.sendOtp('+79991111111', 'Код 123456'), /SMS_PROVIDER_NOT_CONFIGURED/);
    } else {
      await smsProvider.sendOtp('+79991111111', 'Код 123456');
    }
    assert.doesNotMatch(JSON.stringify(logs), /79991111111|123456/);
  } finally {
    console.info = originalInfo;
  }
});

test('concurrent requests reserve one phone challenge before provider calls', async () => {
  const originalTransaction = prisma.$transaction;
  const originalCount = prisma.phoneOtp.count;
  const originalFindFirst = prisma.phoneOtp.findFirst;
  const originalCreate = prisma.phoneOtp.create;
  const originalUpdate = prisma.phoneOtp.update;
  const originalProvider = plusofonService.requestCallToAuth;
  const rows: Array<{ phone: string; purpose: string; createdAt: Date }> = [];
  let tail = Promise.resolve();
  let providerCalls = 0;
  (prisma.$transaction as any) = async (callback: any) => {
    const prior = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await callback({ phoneOtp: prisma.phoneOtp, $queryRaw: async () => [] }); }
    finally { release(); }
  };
  (prisma.phoneOtp.count as any) = async ({ where }: any) => rows.filter((row) => row.phone === where.phone && (!where.purpose || row.purpose === where.purpose)).length;
  (prisma.phoneOtp.findFirst as any) = async ({ where }: any) => rows.find((row) => row.phone === where.phone && row.purpose === where.purpose) ?? null;
  (prisma.phoneOtp.create as any) = async ({ data }: any) => { rows.push(data); return { id: 'otp-1' }; };
  (prisma.phoneOtp.update as any) = async () => ({ id: 'otp-1' });
  (plusofonService.requestCallToAuth as any) = async (phone: string) => { providerCalls++; return { requestId: 'request-1', verificationType: 'call_to_auth', callToAuthNumber: null, phone, raw: {} }; };
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => otpService.requestOtp({ phone: '+79991111111', purpose: 'password_reset' })));
    assert.equal(results.filter((result) => result.ok && !result.throttled).length, 1);
    assert.equal(providerCalls, 1);
    assert.equal(rows.length, 1);
  } finally {
    (prisma.$transaction as any) = originalTransaction;
    (prisma.phoneOtp.count as any) = originalCount;
    (prisma.phoneOtp.findFirst as any) = originalFindFirst;
    (prisma.phoneOtp.create as any) = originalCreate;
    (prisma.phoneOtp.update as any) = originalUpdate;
    (plusofonService.requestCallToAuth as any) = originalProvider;
  }
});
