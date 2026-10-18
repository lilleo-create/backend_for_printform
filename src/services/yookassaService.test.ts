import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';

test('new payment sends the exact order return URL to YooKassa', async () => {
  process.env.JWT_SECRET ??= 'test-secret-longer-than-thirty-two-characters';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-longer-than-thirty-two-characters';
  process.env.OTP_HASH_PEPPER ??= 'test-pepper-longer-than-thirty-two-characters';
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.FRONTEND_URL ??= 'https://example.test';
  const { env } = await import('../config/env');
  const { yookassaService } = await import('./yookassaService');
  const originalPost = axios.post;
  const originalConfig = {
    shopId: env.yookassaShopId,
    secretKey: env.yookassaSecretKey,
    returnUrl: env.yookassaReturnUrl
  };
  const requests: Array<{ url: string; body: any }> = [];
  try {
    env.yookassaShopId = 'test-shop';
    env.yookassaSecretKey = 'test-secret';
    env.yookassaReturnUrl = 'https://print-form.ru/payment/return';
    (axios.post as any) = async (url: string, body: any) => {
      requests.push({ url, body });
      return {
        data: {
          id: 'mock-payment',
          status: 'pending',
          confirmation: { confirmation_url: 'https://example.test/confirmation' }
        }
      };
    };

    await yookassaService.createPayment({
      amount: 10000,
      currency: 'RUB',
      orderId: 'order-123',
      description: 'Test order'
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, 'https://api.yookassa.ru/v3/payments');
    assert.equal(requests[0].body.confirmation.return_url, 'https://print-form.ru/payment/return?orderId=order-123');
  } finally {
    (axios.post as any) = originalPost;
    env.yookassaShopId = originalConfig.shopId;
    env.yookassaSecretKey = originalConfig.secretKey;
    env.yookassaReturnUrl = originalConfig.returnUrl;
  }
});

test('safe deal payment sends the exact supplied order return URL to YooKassa', async () => {
  process.env.JWT_SECRET ??= 'test-secret-longer-than-thirty-two-characters';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-longer-than-thirty-two-characters';
  process.env.OTP_HASH_PEPPER ??= 'test-pepper-longer-than-thirty-two-characters';
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.FRONTEND_URL ??= 'https://example.test';
  const { env } = await import('../config/env');
  const { yookassaService } = await import('./yookassaService');
  const originalPost = axios.post;
  const originalConfig = {
    shopId: env.yookassaShopId,
    secretKey: env.yookassaSecretKey,
    returnUrl: env.yookassaReturnUrl
  };
  let returnUrl: string | undefined;
  try {
    env.yookassaShopId = 'test-shop';
    env.yookassaSecretKey = 'test-secret';
    env.yookassaReturnUrl = 'https://print-form.ru/payment/return';
    (axios.post as any) = async (_url: string, body: any) => {
      returnUrl = body.confirmation.return_url;
      return {
        data: {
          id: 'mock-deal-payment',
          status: 'pending',
          confirmation: { confirmation_url: 'https://example.test/confirmation' }
        }
      };
    };

    const callback = new URL(env.yookassaReturnUrl);
    callback.searchParams.set('orderId', 'order-123');
    await yookassaService.createPaymentInDeal({
      orderId: 'order-123',
      dealId: 'deal-123',
      amountKopecks: 10000,
      currency: 'RUB',
      returnUrl: callback.toString(),
      description: 'Test order'
    });
    assert.equal(returnUrl, 'https://print-form.ru/payment/return?orderId=order-123');
  } finally {
    (axios.post as any) = originalPost;
    env.yookassaShopId = originalConfig.shopId;
    env.yookassaSecretKey = originalConfig.secretKey;
    env.yookassaReturnUrl = originalConfig.returnUrl;
  }
});
