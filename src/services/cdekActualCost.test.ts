import test from 'node:test';
import assert from 'node:assert/strict';
import { extractVerifiedCdekActualCostKopecks, extractVerifiedCdekCosts } from './cdekActualCost';

const snapshot = (status: string, detail: unknown) => ({
  status, raw: { entity: { delivery_detail: detail } }
});

test('CDEK cost is not promoted to actual before physical handoff', () => {
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('ACCEPTED', { total_sum: 261 })), null);
});

test('verified CDEK order keeps base, additional, and full current cost', () => {
  const costs = extractVerifiedCdekCosts(snapshot('ACCEPTED',
    { delivery_sum: 204.75, total_sum: 216.55 }));
  assert.deepEqual(costs, {
    baseAmountKopecks: 20475,
    additionalServicesAmountKopecks: 1180,
    currentTotalAmountKopecks: 21655,
    actualAmountKopecks: null
  });
});

test('physical handoff promotes provider total, not base tariff, to actual', () => {
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('RECEIVED_AT_SHIPMENT_WAREHOUSE',
    { delivery_sum: 204.75, total_sum: 216.55 })), 21655);
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('IN_TRANSIT',
    { delivery_sum: 204.75, total_sum: 220 })), 22000);
});

test('verified post-handoff CDEK detail supplies latest actual seller expense', () => {
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('RECEIVED_AT_SHIPMENT_WAREHOUSE',
    { delivery_sum: 247, total_sum: 261 })), 26100);
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('IN_TRANSIT', { delivery_sum: 261 })), null);
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('DELIVERED', { total_sum: 261 })), 26100);
});

test('missing and invalid CDEK costs do not replace prior quote', () => {
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('DELIVERED', null)), null);
  assert.equal(extractVerifiedCdekActualCostKopecks(snapshot('DELIVERED', { total_sum: -2 })), null);
});
