import test from 'node:test';
import assert from 'node:assert/strict';

const load = async () => {
  process.env.JWT_SECRET ??= 'test-secret-longer-than-thirty-two-characters';
  process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-longer-than-thirty-two-characters';
  process.env.OTP_HASH_PEPPER ??= 'test-pepper-longer-than-thirty-two-characters';
  process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
  process.env.FRONTEND_URL ??= 'https://example.test';
  const [{ prisma }, { cdekService }, { cdekWebhookService }, { payoutService }, { runShipmentsSyncJob }] =
    await Promise.all([
      import('../lib/prisma'),
      import('./cdekService'),
      import('./cdekWebhookService'),
      import('./payoutService'),
      import('../jobs/shipmentsSyncJob')
    ]);
  return { prisma, cdekService, cdekWebhookService, payoutService, runShipmentsSyncJob };
};

const signal = (statusCode: string, uuid = 'cdek-1') => ({
  type: 'ORDER_STATUS',
  uuid: 'webhook-event-1',
  attributes: {
    uuid,
    cdek_number: 'tracking-1',
    status_code: statusCode,
    status_date_time: '2026-10-18T10:00:00Z'
  }
});

const snapshot = (status: string) => ({
  cdekOrderId: 'cdek-1',
  status,
  trackingNumber: 'tracking-1',
  requestUuid: 'request-1',
  relatedEntities: { waybillUrl: null, barcodeUrls: [] },
  raw: {
    entity: {
      uuid: 'cdek-1',
      cdek_number: 'tracking-1',
      statuses: [{ code: status, date_time: '2026-10-18T10:00:00Z' }]
    },
    related_entities: []
  }
});

const harness = async (verifiedStatus: string) => {
  const deps = await load();
  const order: any = {
    id: 'order-1',
    publicNumber: 'PF-1',
    status: 'IN_TRANSIT',
    paymentStatus: 'PAID',
    paidAt: new Date(),
    cdekOrderId: 'cdek-1',
    cdekOrderUuid: 'cdek-1',
    trackingNumber: 'tracking-1',
    cdekStatus: 'SENT_TO_TRANSIT_CITY',
    deliveryStatus: 'IN_TRANSIT',
    sellerDropoffPvzId: 'MSK1',
    buyerPickupPvzId: 'MSK2',
    completedAt: null,
    fundsReleasedAt: null,
    shipment: null
  };
  const events: any[] = [];
  const histories: any[] = [];
  let writes = 0;
  let releases = 0;
  let apiCalls = 0;
  let shipment: any = null;
  const tx: any = {
    $queryRaw: async () => [{ id: order.id }],
    order: {
      findUnique: async () => ({ ...order, shipment }),
      update: async ({ data }: any) => { writes++; Object.assign(order, data); return order; },
      updateMany: async ({ data }: any) => {
        if (order.completedAt) return { count: 0 };
        writes++;
        Object.assign(order, data);
        return { count: 1 };
      }
    },
    orderShipment: {
      upsert: async ({ create, update }: any) => {
        writes++;
        shipment = shipment ? { ...shipment, ...update } : { id: 'shipment-1', ...create };
        order.shipment = shipment;
        return shipment;
      }
    },
    orderShipmentStatusHistory: {
      create: async ({ data }: any) => { writes++; histories.push(data); return data; }
    },
    orderDeliveryEvent: {
      findFirst: async ({ where }: any) => events.find((item) =>
        item.orderId === where.orderId && item.provider === where.provider &&
        item.status === where.status && (item.timestampUtc ?? null) === where.timestampUtc
      ) ?? null,
      create: async ({ data }: any) => { writes++; events.push(data); return data; }
    }
  };
  (deps.prisma.order.findFirst as any) = async ({ where }: any) =>
    where.OR?.some((part: any) => part.cdekOrderId === 'cdek-1' || part.cdekOrderUuid === 'cdek-1') ? { ...order, shipment } : null;
  (deps.prisma.order.findUnique as any) = async () => ({ ...order, shipment });
  (deps.prisma.order.findMany as any) = async () => [{ id: order.id }];
  (deps.prisma.$transaction as any) = async (callback: any) => callback(tx);
  (deps.cdekService.getOrderByUuid as any) = async () => { apiCalls++; return snapshot(verifiedStatus); };
  (deps.payoutService.releaseForDeliveredOrder as any) = async () => {
    releases++;
    return { created: true, skipped: null };
  };
  return {
    ...deps, order, events, histories,
    get shipment() { return shipment; },
    get writes() { return writes; },
    get releases() { return releases; },
    get apiCalls() { return apiCalls; }
  };
};

test('fake DELIVERED follows verified IN_TRANSIT and cannot release funds', async () => {
  const h = await harness('IN_TRANSIT');
  await h.cdekWebhookService.handleWebhookSignal(signal('DELIVERED'));
  assert.equal(h.apiCalls, 1);
  assert.equal(h.order.status, 'IN_TRANSIT');
  assert.equal(h.order.deliveryStatus, 'IN_TRANSIT');
  assert.equal(h.releases, 0);
});

test('verified IN_TRANSIT updates Order and Shipment once', async () => {
  const h = await harness('IN_TRANSIT');
  await h.cdekWebhookService.handleWebhookSignal(signal('IN_TRANSIT'));
  assert.equal(h.order.cdekStatus, 'IN_TRANSIT');
  assert.equal(h.order.deliveryStatusCode, 'IN_TRANSIT');
  assert.equal(h.shipment.status, 'IN_TRANSIT');
  assert.equal(h.histories.length, 1);
  assert.equal(h.events.filter((item) => item.provider === 'CDEK').length, 1);
});

test('verified READY_FOR_PICKUP maps to pickup delivery and in-transit Order and Shipment', async () => {
  const h = await harness('READY_FOR_PICKUP');
  await h.cdekWebhookService.handleWebhookSignal(signal('READY_FOR_PICKUP'));
  assert.equal(h.order.deliveryStatus, 'READY_FOR_PICKUP');
  assert.equal(h.order.status, 'IN_TRANSIT');
  assert.equal(h.shipment.status, 'IN_TRANSIT');
});

test('verified and duplicate DELIVERED complete and release funds once', async () => {
  const h = await harness('DELIVERED');
  await h.cdekWebhookService.handleWebhookSignal(signal('DELIVERED'));
  await h.cdekWebhookService.handleWebhookSignal(signal('DELIVERED'));
  assert.equal(h.order.status, 'DELIVERED');
  assert.ok(h.order.deliveredToRecipientAt);
  assert.ok(h.order.completedAt);
  assert.ok(h.order.fundsReleasedAt);
  assert.equal(h.releases, 1);
  assert.equal(h.events.filter((item) => item.status === 'ORDER_COMPLETED').length, 1);
  assert.equal(h.events.filter((item) => item.provider === 'CDEK').length, 1);
  assert.equal(h.histories.length, 1);
});

test('unknown CDEK UUID causes no CDEK lookup or database mutation', async () => {
  const h = await harness('DELIVERED');
  const result = await h.cdekWebhookService.handleWebhookSignal(signal('DELIVERED', 'unknown-cdek-uuid'));
  assert.equal(result.skipped, 'ORDER_NOT_FOUND');
  assert.equal(h.apiCalls, 0);
  assert.equal(h.writes, 0);
});

test('CDEK verification error causes no status or funds mutation', async () => {
  const h = await harness('DELIVERED');
  (h.cdekService.getOrderByUuid as any) = async () => { throw new Error('CDEK_UNAVAILABLE'); };
  await assert.rejects(() => h.cdekWebhookService.handleWebhookSignal(signal('DELIVERED')), /CDEK_UNAVAILABLE/);
  assert.equal(h.writes, 0);
  assert.equal(h.releases, 0);
});

test('CDEK snapshot with a different UUID cannot mutate the order', async () => {
  const h = await harness('DELIVERED');
  (h.cdekService.getOrderByUuid as any) = async () => ({
    ...snapshot('DELIVERED'),
    cdekOrderId: 'different-cdek-order'
  });
  await assert.rejects(() => h.cdekWebhookService.handleWebhookSignal(signal('DELIVERED')), /CDEK_UUID_MISMATCH/);
  assert.equal(h.writes, 0);
  assert.equal(h.releases, 0);
});

test('other webhook event types are ignored before CDEK lookup', async () => {
  const h = await harness('DELIVERED');
  const result = await h.cdekWebhookService.handleWebhookSignal({ ...signal('DELIVERED'), type: 'PRINT_FORM' });
  assert.equal(result.skipped, 'EVENT_TYPE_INVALID');
  assert.equal(h.apiCalls, 0);
  assert.equal(h.writes, 0);
});

test('background sync uses the same verified apply path', async () => {
  const h = await harness('READY_FOR_PICKUP');
  const result = await h.runShipmentsSyncJob();
  assert.deepEqual(result, { total: 1, synced: 1 });
  assert.equal(h.apiCalls, 1);
  assert.equal(h.order.deliveryStatus, 'READY_FOR_PICKUP');
  assert.equal(h.shipment.status, 'IN_TRANSIT');
});
