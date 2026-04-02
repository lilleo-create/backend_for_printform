import test from 'node:test';
import assert from 'node:assert/strict';
import { mapCdekStatus } from './shipmentsSyncJob';

test('mapCdekStatus maps CREATED/ACCEPTED without forcing IN_TRANSIT', () => {
  assert.equal(mapCdekStatus('CREATED'), 'READY_FOR_SHIPMENT');
  assert.equal(mapCdekStatus('ACCEPTED'), 'HANDED_TO_DELIVERY');
  assert.equal(mapCdekStatus('SENT_TO_TRANSIT_CITY'), 'IN_TRANSIT');
  assert.equal(mapCdekStatus('DELIVERED'), 'DELIVERED');
  assert.equal(mapCdekStatus('NOT_DELIVERED'), 'FAILED');
  assert.equal(mapCdekStatus('REMOVED'), 'CANCELLED');
});
