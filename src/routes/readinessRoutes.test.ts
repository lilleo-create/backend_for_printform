import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { createReadinessRouter } from './readinessRoutes';

test('ready returns 200 after DB probe succeeds', async () => {
  const app = express();
  app.use('/ready', createReadinessRouter(async () => 1));
  const response = await request(app).get('/ready');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { status: 'ready' });
});

test('ready returns 503 without leaking DB error detail', async () => {
  const app = express();
  app.use('/ready', createReadinessRouter(async () => { throw new Error('postgres://secret'); }));
  const response = await request(app).get('/ready');
  assert.equal(response.status, 503);
  assert.deepEqual(response.body, { status: 'unavailable' });
  assert.doesNotMatch(response.text, /secret|postgres:/);
});
