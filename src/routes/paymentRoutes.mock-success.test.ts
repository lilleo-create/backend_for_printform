import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { paymentRoutes } from './paymentRoutes';
import { errorHandler } from '../middleware/errorHandler';
import { yookassaWebhookService } from '../services/yookassaWebhookService';

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

test('yookassa webhook forwards succeeded signal without trusting body status or amount', async () => {
  let payload: any = null;
  const original = yookassaWebhookService.handlePaymentSignal;
  (yookassaWebhookService.handlePaymentSignal as any) = async (event: string, input: any) => {
    payload = { event, ...input };
    return { reason: 'APPLIED' };
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
  assert.deepEqual(payload, { event: 'payment.succeeded', externalId: 'yk-pay-1', bodyOrderId: 'order-1' });
  yookassaWebhookService.handlePaymentSignal = original;
});

test('yookassa webhook maps payment.canceled to canceled', async () => {
  let payload: any = null;
  const original = yookassaWebhookService.handlePaymentSignal;
  (yookassaWebhookService.handlePaymentSignal as any) = async (event: string, input: any) => {
    payload = { event, ...input };
    return { reason: 'APPLIED' };
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
  assert.equal(payload.event, 'payment.canceled');
  yookassaWebhookService.handlePaymentSignal = original;
});

test('yookassa webhook forwards refund signal', async () => {
  let payload: any = null;
  const original = yookassaWebhookService.handleRefundSignal;
  (yookassaWebhookService.handleRefundSignal as any) = async (input: any) => {
    payload = input;
    return { reason: 'APPLIED' };
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
  assert.deepEqual(payload, { externalId: 'yk-refund-1', bodyOrderId: 'order-3' });
  yookassaWebhookService.handleRefundSignal = original;
});
