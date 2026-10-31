import test from 'node:test';
import assert from 'node:assert/strict';
import { safeCdekError } from './safeCdekError';
import { verifyCreatedCdekOrderReadback } from './cdekReadback';

const snapshot = (uuid: string) => ({ cdekOrderId: uuid, status: 'CREATED', trackingNumber: '123' });
const missing = () => ({ response: { status: 400, data: { requests: [{ errors: [{ code: 'v2_entity_not_found' }] }] } } });

test('readback immediately verifies a newly created order', async () => {
  let calls = 0;
  const result = await verifyCreatedCdekOrderReadback({ orderId: 'order-1', cdekOrderUuid: 'uuid-1', requestId: 'req-1',
    getOrder: async () => { calls++; return snapshot('uuid-1') as any; }, sleep: async () => {} });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.attempts, 1);
  assert.equal(calls, 1);
});

test('readback retries entity_not_found and verifies on the third GET', async () => {
  let calls = 0;
  const result = await verifyCreatedCdekOrderReadback({ orderId: 'order-1', cdekOrderUuid: 'uuid-1', requestId: 'req-1',
    getOrder: async () => { calls++; if (calls < 3) throw missing(); return snapshot('uuid-1') as any; }, sleep: async () => {} });
  assert.equal(result.status, 'VERIFIED');
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
});

test('readback exhausts bounded retries without another create', async () => {
  let calls = 0;
  const result = await verifyCreatedCdekOrderReadback({ orderId: 'order-1', cdekOrderUuid: 'uuid-1', requestId: 'req-1',
    getOrder: async () => { calls++; throw missing(); }, sleep: async () => {} });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.reasonCode, 'CDEK_ORDER_READBACK_PENDING');
  assert.equal(result.attempts, 4);
  assert.equal(calls, 4);
});

test('readback treats 401 and 403 as auth failures without retries', async () => {
  for (const httpStatus of [401, 403]) {
    let calls = 0;
    const result = await verifyCreatedCdekOrderReadback({ orderId: 'order-1', cdekOrderUuid: 'uuid-1', requestId: 'req-1',
      getOrder: async () => { calls++; throw { response: { status: httpStatus } }; }, sleep: async () => {} });
    assert.equal(result.status, 'AUTH_FAILED');
    assert.equal(calls, 1);
  }
});

test('readback refuses a UUID from the wrong account or environment', async () => {
  let calls = 0;
  const result = await verifyCreatedCdekOrderReadback({ orderId: 'order-1', cdekOrderUuid: 'uuid-1', requestId: 'req-1',
    getOrder: async () => { calls++; return snapshot('different-uuid') as any; }, sleep: async () => {} });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.reasonCode, 'CDEK_ORDER_READBACK_FAILED');
  assert.equal(calls, 1);
});

test('safeCdekError omits Axios authorization while retaining provider errors', () => {
  const error = { message: 'Request failed with status code 400', code: 'ERR_BAD_REQUEST',
    config: { headers: { Authorization: 'Bearer TEST_SECRET_DO_NOT_LOG' }, data: { client_secret: 'TEST_SECRET_DO_NOT_LOG' } },
    response: { status: 400, config: { headers: { Authorization: 'Bearer TEST_SECRET_DO_NOT_LOG' } },
      data: { requests: [{ errors: [{ code: 'v2_entity_not_found', additional_code: '404-1', message: 'Заказ не найден' }] }] } } };
  const result = safeCdekError(error, 'getOrderInfo');
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /TEST_SECRET_DO_NOT_LOG|Bearer|Authorization|client_secret/);
  assert.match(text, /v2_entity_not_found|Заказ не найден|getOrderInfo/);
  assert.equal(result.httpStatus, 400);
});
