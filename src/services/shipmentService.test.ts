import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { mapExternalStatusToInternal, normalizePvzProvider, shipmentService } from './shipmentService';

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


test('syncByOrderId persists trackingNumber even when snapshot value has extra spaces', async () => {
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

  (prisma.$transaction as any) = async (cb: any) => cb({
    orderShipment: {
      upsert: async () => ({ id: 'shipment-1', status: 'READY_TO_SHIP', statusRaw: {} })
    },
    order: {
      update: async ({ data }: any) => {
        assert.equal(data.trackingNumber, '1234567890');
        return {};
      }
    },
    orderShipmentStatusHistory: {
      create: async () => ({ id: 'history-1' })
    }
  });

  const result = await shipmentService.syncByOrderId('order-1');
  assert.equal(result.snapshot.trackingNumber, ' 1234567890 ');
});
