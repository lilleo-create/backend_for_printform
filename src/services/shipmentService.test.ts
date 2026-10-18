import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { cdekWebhookService } from './cdekWebhookService';
import {
  isValidCdekPvzCode,
  mapExternalStatusToInternal,
  normalizeCdekPvzCode,
  normalizePvzProvider,
  shipmentService
} from './shipmentService';

test('mapExternalStatusToInternal maps CDEK statuses', () => {
  assert.equal(mapExternalStatusToInternal('ACCEPTED'), 'READY_TO_SHIP');
  assert.equal(mapExternalStatusToInternal('IN_TRANSIT'), 'IN_TRANSIT');
  assert.equal(mapExternalStatusToInternal('READY_FOR_PICKUP'), 'IN_TRANSIT');
  assert.equal(mapExternalStatusToInternal('DELIVERED'), 'DELIVERED');
  assert.equal(mapExternalStatusToInternal('INVALID'), 'CANCELLED');
});

test('normalizePvzProvider upgrades legacy provider to CDEK when pvz code matches', async () => {
  let updated = false;
  (prisma.order.update as any) = async ({ data }: any) => {
    updated = data?.buyerPickupPvzMeta?.provider === 'CDEK';
    return {};
  };

  const order = {
    id: 'o-1',
    carrier: 'CDEK',
    buyerPickupPvzId: 'MSK117',
    buyerPickupPvzMeta: { provider: 'LEGACY' }
  };

  const normalized = await normalizePvzProvider(order as any);

  assert.equal(updated, true);
  assert.equal((normalized as any).buyerPickupPvzMeta.provider, 'CDEK');
});

test('CDEK PVZ validator accepts real alphanumeric codes and normalizes case/whitespace', () => {
  assert.equal(normalizeCdekPvzCode('  spb123 '), 'SPB123');
  assert.equal(normalizeCdekPvzCode('  abc123  '), 'ABC123');
  assert.equal(isValidCdekPvzCode('TRTS13'), true);
  assert.equal(isValidCdekPvzCode('MSK664'), true);
  assert.equal(isValidCdekPvzCode('  spb123 '), true);
  assert.equal(isValidCdekPvzCode('  ABC123  '), true);
});

test('CDEK PVZ validator rejects empty and obviously invalid values', () => {
  assert.equal(isValidCdekPvzCode(''), false);
  assert.equal(isValidCdekPvzCode('   '), false);
  assert.equal(isValidCdekPvzCode('@@@'), false);
  assert.equal(isValidCdekPvzCode('abc 123'), false);
});


test('syncByOrderId applies the authenticated CDEK snapshot through the shared path', async () => {
  (prisma.order.findUnique as any) = async () => ({
    id: 'order-1',
    cdekOrderId: 'cdek-order-uuid',
    sellerDropoffPvzId: 'MSK1',
    buyerPickupPvzId: 'MSK2',
    shipment: null
  });

  (cdekService.getOrderByUuid as any) = async () => ({
    cdekOrderId: 'cdek-order-uuid',
    status: 'ACCEPTED',
    trackingNumber: ' 1234567890 ',
    requestUuid: 'request-1',
    relatedEntities: { waybillUrl: null, barcodeUrls: [] },
    raw: { related_entities: [] }
  });

  let applied = false;
  (cdekWebhookService.applyVerifiedCdekStatus as any) = async (orderId: string, verified: any) => {
    applied = orderId === 'order-1' && verified.cdekOrderId === 'cdek-order-uuid';
  };
  (prisma.orderShipment.findUnique as any) = async () => ({ id: 'shipment-1', status: 'READY_TO_SHIP' });

  const result = await shipmentService.syncByOrderId('order-1');
  assert.equal(applied, true);
  assert.equal(result.snapshot.trackingNumber, ' 1234567890 ');
});
