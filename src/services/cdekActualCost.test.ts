import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVerifiedCdekActualCostKopecks } from './cdekActualCost';

const snapshot = (status: string, detail: unknown) => ({
  status, raw: { entity: { delivery_detail: detail } }
});

test('CDEK cost is not promoted to actual before physical handoff', () => {
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('ACCEPTED', { total_sum: 261 })), null);
});

test('verified post-handoff CDEK detail supplies latest actual seller expense', () => {
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('RECEIVED_AT_SHIPMENT_WAREHOUSE',
    { delivery_sum: 247, total_sum: 261 })), 24700);
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('IN_TRANSIT', { delivery_sum: 261 })), 26100);
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('DELIVERED', { total_sum: 261 })), null);
});

test('missing and invalid CDEK costs do not replace prior quote', () => {
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('DELIVERED', null)), null);
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('DELIVERED', { total_sum: -2 })), null);
});
