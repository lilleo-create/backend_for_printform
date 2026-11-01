import test from 'node:test';
import assert from 'node:assert/strict';
import { canCreateReturnForOrderStatus } from './returnEligibility';

test('return creation is limited to delivered orders', () => {
  assert.equal(canCreateReturnForOrderStatus('READY_FOR_SHIPMENT'), false);
  assert.equal(canCreateReturnForOrderStatus('IN_TRANSIT'), false);
  assert.equal(canCreateReturnForOrderStatus('DELIVERED'), true);
});
