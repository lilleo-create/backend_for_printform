import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { paymentRoutes } from './paymentRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { paymentFlowService } from '../services/paymentFlowService';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/payments', paymentRoutes);
  app.use(errorHandler);
  return app;
};

const sendWebhook = async (body: unknown) => {
  const app = buildApp();
  const server = app.listen(0);

  try {
    const { port } = server.address() as AddressInfo;

    const response = await fetch(`http://127.0.0.1:${port}/payments/yookassa/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    return response;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

test('yookassa webhook maps payment.succeeded to succeeded', async () => {
  let payload: any = null;
  (paymentFlowService.processWebhook as any) = async (input: any) => {
    payload = input;
    return { ok: true };
  };

  const response = await sendWebhook({
    event: 'payment.succeeded',
    object: {
      id: 'yk-pay-1',
      status: 'succeeded',
      amount: { value: '1.00' },
      metadata: { orderId: 'order-1' }
    }
  });

  assert.equal(response.status, 200);
  assert.equal(payload.externalId, 'yk-pay-1');
  assert.equal(payload.status, 'succeeded');
  assert.equal(payload.orderId, 'order-1');
  assert.equal(payload.amount, '1.00');
  assert.equal(payload.provider, 'yookassa');
});

test('yookassa webhook maps payment.canceled to canceled', async () => {
  let payload: any = null;
  (paymentFlowService.processWebhook as any) = async (input: any) => {
    payload = input;
    return { ok: true };
  };

  const response = await sendWebhook({
    event: 'payment.canceled',
    object: {
      id: 'yk-pay-2',
      status: 'canceled',
      amount: { value: '1.00' },
      metadata: { orderId: 'order-2' }
    }
  });

  assert.equal(response.status, 200);
  assert.equal(payload.externalId, 'yk-pay-2');
  assert.equal(payload.status, 'canceled');
});

test('yookassa webhook maps refund.succeeded to processRefundWebhook', async () => {
  let payload: any = null;
  (paymentFlowService.processRefundWebhook as any) = async (input: any) => {
    payload = input;
    return { ok: true };
  };

  const response = await sendWebhook({
    event: 'refund.succeeded',
    object: {
      id: 'yk-refund-1',
      status: 'succeeded',
      amount: { value: '1.00' },
      metadata: { orderId: 'order-3' }
    }
  });

  assert.equal(response.status, 200);
  assert.equal(payload.externalRefundId, 'yk-refund-1');
  assert.equal(payload.amount, '1.00');
  assert.equal(payload.orderId, 'order-3');
});
