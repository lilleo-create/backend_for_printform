import test from 'node:test';
import assert from 'node:assert/strict';
import { errorHandler } from './errorHandler';

const makeRes = () => {
  let statusCode = 0;
  let payload: any = null;
  const res = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(body: unknown) {
      payload = body;
      return this;
    }
  } as any;

  return { res, get: () => ({ statusCode, payload }) };
};

test('ORDER_NOT_PAID maps to 409', () => {
  const ctx = makeRes();
  errorHandler(new Error('ORDER_NOT_PAID'), {} as any, ctx.res, (() => {}) as any);
  assert.equal(ctx.get().statusCode, 409);
  assert.deepEqual(ctx.get().payload, { error: { code: 'ORDER_NOT_PAID' } });
});

test('extended NDD error code maps from error fields', () => {
  const ctx = makeRes();
  const error = Object.assign(new Error('NDD failed'), {
    code: 'NDD_REQUEST_FAILED',
    status: 502,
    details: { reason: 'disabled' }
  });

  errorHandler(error, {} as any, ctx.res, (() => {}) as any);
  assert.equal(ctx.get().statusCode, 502);
  assert.deepEqual(ctx.get().payload, {
    error: { code: 'NDD_REQUEST_FAILED', details: { reason: 'disabled' } }
  });
});
