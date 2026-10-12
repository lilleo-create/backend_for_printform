import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { quoteCheckoutShipping } from './checkoutShippingService';

const originalProducts = prisma.product.findMany;
const originalSettings = prisma.sellerSettings.findUnique;
const originalCalculate = cdekService.calculateDelivery;
test.afterEach(() => {
  (prisma.product.findMany as any) = originalProducts;
  (prisma.sellerSettings.findUnique as any) = originalSettings;
  (cdekService.calculateDelivery as any) = originalCalculate;
});

test('checkout quote reads product measurements, quantity and seller/buyer cities', async () => {
  (prisma.product.findMany as any) = async () => [
    { id: 'a', sellerId: 's', weightGrossG: 350, dxCm: 19, dyCm: 12.5, dzCm: 9.5 },
    { id: 'b', sellerId: 's', weightGrossG: 100, dxCm: 3, dyCm: 22, dzCm: 2 }
  ];
  (prisma.sellerSettings.findUnique as any) = async () => ({
    defaultDropoffPvzId: 'MSK1', defaultDropoffPvzMeta: { raw: { city_code: 44 } }
  });
  let sent: any;
  (cdekService.calculateDelivery as any) = async (params: any) => {
    sent = params;
    return { totalSum: 421.25, deliverySum: 421.25, deliveryDaysMin: 2, deliveryDaysMax: 4 };
  };
  const result = await quoteCheckoutShipping(
    [{ productId: 'a', quantity: 3 }, { productId: 'b', quantity: 1 }],
    { pvzId: 'SPB1', raw: { city_code: 137 } }
  );
  assert.deepEqual(sent, {
    fromCityCode: 44, toCityCode: 137, weightGrams: 1150,
    lengthCm: 19, widthCm: 22, heightCm: 31,
    shipmentPoint: 'MSK1', deliveryPoint: 'SPB1'
  });
  assert.equal(result.deliveryAmountKopecks, 42125);
  assert.equal(result.snapshot.packages[0].heightCm, 30.5);
});

test('checkout quote rejects missing city code and CDEK failure', async () => {
  (prisma.product.findMany as any) = async () => [
    { id: 'a', sellerId: 's', weightGrossG: 350, dxCm: 19, dyCm: 12, dzCm: 9.5 }
  ];
  (prisma.sellerSettings.findUnique as any) = async () => ({
    defaultDropoffPvzId: 'MSK1', defaultDropoffPvzMeta: { raw: { city_code: 44 } }
  });
  await assert.rejects(quoteCheckoutShipping([{ productId: 'a', quantity: 1 }], { raw: {} }),
    { code: 'BUYER_CITY_CODE_REQUIRED' });
  (cdekService.calculateDelivery as any) = async () => { throw new Error('CDEK offline'); };
  await assert.rejects(quoteCheckoutShipping([{ productId: 'a', quantity: 1 }], { pvzId: 'SPB1', raw: { city_code: 137 } }),
    { code: 'CDEK_QUOTE_FAILED' });
});
