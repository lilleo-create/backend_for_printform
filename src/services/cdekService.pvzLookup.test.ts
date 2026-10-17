import test from 'node:test';
import assert from 'node:assert/strict';
import { cdekService } from './cdekService';

test('PVZ city lookup filters CDEK deliverypoints by exact code and rejects missing points', async () => {
  const service = cdekService as any;
  const originalToken = service.getToken;
  const originalRequest = service.request;
  const requests: any[] = [];
  try {
    service.getToken = async () => 'test-token';
    service.request = async (_name: string, config: any) => {
      requests.push(config);
      return [{ code: 'OTHER', location: { city_code: 1 } },
        { code: 'MSK1', location: { city_code: 44, city: 'Moscow' } }];
    };
    assert.equal(await cdekService.getCityCodeByPvzCode('msk1'), 44);
    assert.equal(requests[0].url, 'https://api.cdek.ru/v2/deliverypoints');
    assert.deepEqual(requests[0].params, { code: 'MSK1', type: 'PVZ' });
    assert.equal(await cdekService.getCityCodeByPvzCode('missing'), null);
    const point = await cdekService.getPickupPointByCode('msk1');
    assert.equal(point.location.city_code, 44);
  } finally {
    service.getToken = originalToken;
    service.request = originalRequest;
  }
});
