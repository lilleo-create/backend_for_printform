import test from 'node:test';
import assert from 'node:assert/strict';
import { cdekService } from './cdekService';
import { normalizeSellerDropoffPvzMeta } from './sellerDropoffPvzMetaService';

test('new seller dropoff metadata keeps widget city and coordinates at the top level', async () => {
  const original = cdekService.getPickupPointByCode;
  try {
    (cdekService.getPickupPointByCode as any) = async () => { throw new Error('lookup must not run'); };
    const meta = await normalizeSellerDropoffPvzMeta('MSK1', {
      cityCode: 44, cityName: 'Moscow', addressFull: 'Point address',
      latitude: 55.7, longitude: 37.6, raw: { code: 'MSK1' }
    });
    assert.deepEqual(meta, { provider: 'CDEK', pvzId: 'MSK1', cityCode: 44,
      cityName: 'Moscow', addressFull: 'Point address', latitude: 55.7,
      longitude: 37.6, raw: { code: 'MSK1' } });
  } finally {
    (cdekService.getPickupPointByCode as any) = original;
  }
});

test('new seller dropoff metadata resolves missing city by a scoped CDEK PVZ lookup', async () => {
  const original = cdekService.getPickupPointByCode;
  try {
    (cdekService.getPickupPointByCode as any) = async (code: string) => {
      assert.equal(code, 'MSK1');
      return { code, name: 'Point', type: 'PVZ', location: {
        city_code: 44, city: 'Moscow', address_full: 'Point address',
        latitude: 55.7, longitude: 37.6
      } };
    };
    const meta = await normalizeSellerDropoffPvzMeta('MSK1', {});
    assert.equal(meta.cityCode, 44);
    assert.equal(meta.cityName, 'Moscow');
    assert.equal(meta.addressFull, 'Point address');
    assert.equal(meta.latitude, 55.7);
    assert.equal(meta.longitude, 37.6);
  } finally {
    (cdekService.getPickupPointByCode as any) = original;
  }
});
