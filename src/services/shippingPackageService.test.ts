import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShippingSnapshot, calculateShippingQuote, ShippingQuoteError, toCdekPackage,
  validatePackedParcel, toCdekPackedParcel } from './shippingPackageService';
import { calculatePackedShippingQuote } from './shippingPackageService';

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

test('successful quote uses the same CDEK package and returns actual cost in kopecks', async () => {
  const snapshot = buildShippingSnapshot([item({ quantity: 3 })]);
  let sent: any;
  const result = await calculateShippingQuote(snapshot, 1, 42, async (params) => {
    sent = params;
    return { totalSum: 275.5, deliverySum: 275.5, deliveryDaysMin: 2,
      deliveryDaysMax: 4, calendarMin: null, calendarMax: null, tariffCode: 136 };
  });
  assert.deepEqual(sent, { fromCityCode: 1, toCityCode: 42, ...toCdekPackage(snapshot) });
  assert.equal(result.deliveryAmountKopecks, 27550);
  await assert.rejects(calculateShippingQuote(snapshot, 1, 42, async () => ({
    ...result.quote, totalSum: 0
  })), { code: 'CDEK_QUOTE_INVALID' });
});

test('packed parcel can weigh more than product items and uses its own external dimensions', () => {
  const snapshot = buildShippingSnapshot([item()]);
  const packed = { weightGrams: 520, lengthCm: 21.5, widthCm: 14.2, heightCm: 11.1 };
  assert.deepEqual(validatePackedParcel(packed, snapshot), packed);
  assert.deepEqual(toCdekPackedParcel(packed), {
    weightGrams: 520, lengthCm: 22, widthCm: 15, heightCm: 12
  });
});

test('packed parcel rejects underweight and undersized boxes, allowing product rotation', () => {
  const snapshot = buildShippingSnapshot([item()]);
  assert.throws(() => validatePackedParcel({ weightGrams: 349, lengthCm: 22, widthCm: 14, heightCm: 11 }, snapshot),
    { code: 'PACKED_WEIGHT_TOO_LOW' });
  assert.throws(() => validatePackedParcel({ weightGrams: 500, lengthCm: 19, widthCm: 12, heightCm: 9 }, snapshot),
    { code: 'PACKED_DIMENSIONS_TOO_SMALL' });
  assert.doesNotThrow(() => validatePackedParcel({ weightGrams: 500, lengthCm: 10, widthCm: 20, heightCm: 13 }, snapshot));
});

test('legacy one-item checkout snapshot still checks product dimensions', () => {
  const snapshot = buildShippingSnapshot([item()]);
  snapshot.items[0] = { productId: 'a', quantity: 1, weightGrossG: 350 };
  assert.throws(() => validatePackedParcel({ weightGrams: 500, lengthCm: 19, widthCm: 12, heightCm: 9 }, snapshot),
    { code: 'PACKED_DIMENSIONS_TOO_SMALL' });
});

test('packed measurements must be positive, finite and within physical limits', () => {
  const snapshot = buildShippingSnapshot([item()]);
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 100_001]) {
    assert.throws(() => validatePackedParcel({ weightGrams: bad, lengthCm: 20, widthCm: 13, heightCm: 10 }, snapshot),
      { code: 'PACKED_WEIGHT_INVALID' });
  }
  assert.throws(() => validatePackedParcel({ weightGrams: 500, lengthCm: 301, widthCm: 13, heightCm: 10 }, snapshot),
    { code: 'PACKED_DIMENSIONS_INVALID' });
});

test('packed CDEK quote uses the measured parcel rather than checkout product dimensions', async () => {
  const snapshot = buildShippingSnapshot([item()]);
  let sent: any;
  const result = await calculatePackedShippingQuote(
    { weightGrams: 520, lengthCm: 21.5, widthCm: 14.2, heightCm: 11.1 }, snapshot, 1, 42,
    async params => { sent = params; return { totalSum: 247, deliverySum: 247,
      deliveryDaysMin: 2, deliveryDaysMax: 4, calendarMin: null, calendarMax: null, tariffCode: 136 }; }
  );
  assert.deepEqual(sent, { fromCityCode: 1, toCityCode: 42, weightGrams: 520,
    lengthCm: 22, widthCm: 15, heightCm: 12 });
  assert.equal(result.deliveryAmountKopecks, 24700);
});
