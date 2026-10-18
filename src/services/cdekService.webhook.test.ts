import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { cdekService } from './cdekService';

const url = 'https://print-form.ru/api/cdek/webhooks/order-status';

test('CDEK webhook registration reads array response and does not create duplicate', async () => {
  const originalRequest = axios.request;
  const originalGetToken = cdekService.getToken;
  let posts = 0;
  try {
    (cdekService.getToken as any) = async () => 'mock-token';
    (axios.request as any) = async ({ method }: any) => {
      if (method === 'GET') return { status: 200, data: [{ uuid: 'webhook-1', type: 'ORDER_STATUS', url }] };
      posts++;
      throw new Error('UNEXPECTED_POST');
    };
    const result = await cdekService.ensureOrderStatusWebhook(url);
    assert.deepEqual(result, { created: false, webhookUuid: 'webhook-1', total: 1 });
    assert.equal(posts, 0);
  } finally {
    (axios.request as any) = originalRequest;
    (cdekService.getToken as any) = originalGetToken;
  }
});

test('CDEK webhook registration accepts entity UUID returned by POST', async () => {
  const originalRequest = axios.request;
  const originalGetToken = cdekService.getToken;
  let posts = 0;
  try {
    (cdekService.getToken as any) = async () => 'mock-token';
    (axios.request as any) = async ({ method }: any) => {
      if (method === 'GET') return { status: 200, data: [] };
      posts++;
      return { status: 200, data: { entity: { uuid: 'webhook-2' }, requests: [] } };
    };
    const result = await cdekService.ensureOrderStatusWebhook(url);
    assert.deepEqual(result, { created: true, webhookUuid: 'webhook-2', total: 1 });
    assert.equal(posts, 1);
  } finally {
    (axios.request as any) = originalRequest;
    (cdekService.getToken as any) = originalGetToken;
  }
});
