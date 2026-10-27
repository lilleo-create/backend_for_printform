import test from 'node:test';
import assert from 'node:assert/strict';
import { cdekService } from './cdekService';

test('CDEK create-order request contains real contacts and consistent parcel values', async () => {
  const originalToken = cdekService.getToken;
  const originalRequest = (cdekService as any).request;
  let requestCount = 0;
  let body: any;
  try {
    (cdekService.getToken as any) = async () => 'test-token';
    (cdekService as any).request = async (_operation: string, config: any) => {
      requestCount++;
      body = config.data;
      return { entity: { uuid: 'cdek-uuid' }, requests: [{ state: 'OK' }] };
    };
    const payload = {
      orderId: 'order-1', fromPvzCode: 'SPB123', toPvzCode: 'MSK123',
      senderName: 'Real Seller', senderPhone: '89991234567',
      recipientName: 'Real Buyer', recipientPhone: '89997654321',
      weightGrams: 1050, lengthCm: 19, widthCm: 13, heightCm: 29,
      items: [{ id: 'item-1', name: 'Product', article: 'SKU-1', price: 20475, quantity: 3, weight: 350 }]
    };
    await cdekService.createOrderFromMarketplaceOrder(payload);
    assert.equal(requestCount, 1);
    assert.equal(body.tariff_code, 136);
    assert.equal(body.shipment_point, 'SPB123');
    assert.equal(body.delivery_point, 'MSK123');
    assert.deepEqual(body.sender, { name: 'Real Seller', phones: [{ number: '+79991234567' }] });
    assert.deepEqual(body.recipient, { name: 'Real Buyer', phones: [{ number: '+79997654321' }] });
    assert.deepEqual({ weight: body.packages[0].weight, length: body.packages[0].length,
      width: body.packages[0].width, height: body.packages[0].height },
    { weight: 1050, length: 19, width: 13, height: 29 });
    assert.deepEqual(body.packages[0].items[0], {
      name: 'Product', ware_key: 'SKU-1', payment: { value: 0 },
      cost: 204.75, weight: 350, amount: 3
    });

    for (const invalid of [
      { senderName: '' }, { senderPhone: '' }, { senderPhone: '+70000000000' },
      { recipientName: '' }, { recipientPhone: '' }, { recipientPhone: '+70000000000' }
    ]) {
      await assert.rejects(cdekService.createOrderFromMarketplaceOrder({ ...payload, ...invalid }));
    }
    assert.equal(requestCount, 1);
  } finally {
    (cdekService.getToken as any) = originalToken;
    (cdekService as any).request = originalRequest;
  }
});
