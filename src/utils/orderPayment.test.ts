import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { PAYMENT_WINDOW_MS, expirePendingPayments, nextPaymentExpiryDate } from './orderPayment';
import { runPaymentExpiryJob } from '../jobs/paymentExpiryJob';

test('new payment window lasts 20 minutes from server time', () => {
  const base = new Date('2026-11-01T12:00:00.000Z');
  assert.equal(PAYMENT_WINDOW_MS, 20 * 60 * 1000);
  assert.equal(nextPaymentExpiryDate(base).toISOString(), '2026-11-01T12:20:00.000Z');
});

test('background expiry updates only overdue unpaid pending orders', async () => {
  const original = prisma.order.updateMany;
  let query: any;
  (prisma.order.updateMany as any) = async (input: any) => { query = input; return { count: 1 }; };
  try {
    await expirePendingPayments();
    assert.equal(query.where.paymentStatus, 'PENDING_PAYMENT');
    assert.equal(query.where.paidAt, null);
    assert.ok(query.where.paymentExpiresAt.lt instanceof Date);
    assert.equal(query.data.paymentStatus, 'PAYMENT_EXPIRED');
    assert.equal(query.data.status, 'EXPIRED');
    assert.ok(query.data.expiredAt instanceof Date);
    assert.ok(query.data.statusUpdatedAt instanceof Date);
  } finally { (prisma.order.updateMany as any) = original; }
});

test('scheduled job runs expiry independently of buyer requests', async () => {
  const original = prisma.order.updateMany;
  let calls = 0;
  (prisma.order.updateMany as any) = async () => { calls++; return { count: 1 }; };
  try {
    await runPaymentExpiryJob();
    assert.equal(calls, 1);
  } finally { (prisma.order.updateMany as any) = original; }
});
