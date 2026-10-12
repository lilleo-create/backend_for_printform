import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShippingSnapshot, calculateShippingQuote, ShippingQuoteError, toCdekPackage } from './shippingPackageService';

const item = (overrides: Partial<Parameters<typeof buildShippingSnapshot>[0][number]> = {}) => ({
  productId: 'a', quantity: 1, weightGrossG: 350, dxCm: 19, dyCm: 12, dzCm: 9.5, ...overrides
});

test('one item and one unit retain decimal dimensions in the snapshot', () => {
  const snapshot = buildShippingSnapshot([item()]);
  assert.deepEqual(snapshot.packages, [{ weightGrams: 350, lengthCm: 19, widthCm: 12, heightCm: 9.5 }]);
  assert.deepEqual(toCdekPackage(snapshot), { weightGrams: 350, lengthCm: 19, widthCm: 12, heightCm: 10 });
});

test('three units accumulate weight and height', () => {
  const snapshot = buildShippingSnapshot([item({ quantity: 3 })]);
  assert.deepEqual(snapshot.packages[0], { weightGrams: 1050, lengthCm: 19, widthCm: 12, heightCm: 28.5 });
  assert.equal(toCdekPackage(snapshot).heightCm, 29);
});

test('different products use both footprints and all heights', () => {
  const snapshot = buildShippingSnapshot([
    item({ quantity: 2 }),
    item({ productId: 'b', weightGrossG: 150, dxCm: 5.5, dyCm: 24.2, dzCm: 1.1 })
  ]);
  assert.deepEqual(snapshot.packages[0], { weightGrams: 850, lengthCm: 19, widthCm: 24.2, heightCm: 20.1 });
  assert.deepEqual(toCdekPackage(snapshot), { weightGrams: 850, lengthCm: 19, widthCm: 25, heightCm: 21 });
});

test('missing weight or dimensions fail closed', () => {
  assert.throws(() => buildShippingSnapshot([item({ weightGrossG: null })]), { code: 'SHIPPING_WEIGHT_REQUIRED' });
  assert.throws(() => buildShippingSnapshot([item({ dxCm: null })]), { code: 'SHIPPING_DIMENSIONS_REQUIRED' });
});

test('missing city code and CDEK failure block the quote', async () => {
  const snapshot = buildShippingSnapshot([item()]);
  await assert.rejects(calculateShippingQuote(snapshot, 0, 42), { code: 'SELLER_CITY_CODE_REQUIRED' });
  await assert.rejects(calculateShippingQuote(snapshot, 1, 0), { code: 'BUYER_CITY_CODE_REQUIRED' });
  await assert.rejects(calculateShippingQuote(snapshot, 1, 42, async () => { throw new Error('network'); }), { code: 'CDEK_QUOTE_FAILED' });
});

test('successful quote uses the same CDEK package and gives kopecks for the order/payment total', async () => {
  const snapshot = buildShippingSnapshot([item({ quantity: 3 })]);
  let sent: any;
  const result = await calculateShippingQuote(snapshot, 1, 42, async (params) => {
    sent = params;
    return { totalSum: 275.5, deliverySum: 275.5, deliveryDaysMin: 2,
      deliveryDaysMax: 4, calendarMin: null, calendarMax: null, tariffCode: 136 };
  });
  assert.deepEqual(sent, { fromCityCode: 1, toCityCode: 42, ...toCdekPackage(snapshot) });
  assert.equal(result.deliveryAmountKopecks, 27550);
  assert.equal(30000 + result.deliveryAmountKopecks, 57550);
  await assert.rejects(calculateShippingQuote(snapshot, 1, 42, async () => ({
    ...result.quote, totalSum: 0
  })), { code: 'CDEK_QUOTE_INVALID' });
});
