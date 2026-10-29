import test from 'node:test';
import assert from 'node:assert/strict';
import { financialsForBuyer, financialsForSeller } from './serializers';

test('buyer sees only the amount actually charged while seller sees real CDEK cost', () => {
  const order = {
    total: 150000, currency: 'RUB',
    deliveryAmountKopecks: 20475, deliveryChargedToBuyerKopecks: 0
  };
  assert.deepEqual(financialsForBuyer(order), {
    itemsSubtotal: 150000, deliveryAmount: 0, total: 150000, currency: 'RUB'
  });
  assert.equal(financialsForSeller(order).actualDeliveryAmount, 20475);
});

test('historical buyer financials preserve delivery already included in total', () => {
  const order = {
    total: 170475, currency: 'RUB',
    deliveryAmountKopecks: 20475, deliveryChargedToBuyerKopecks: 20475
  };
  assert.deepEqual(financialsForBuyer(order), {
    itemsSubtotal: 150000, deliveryAmount: 20475, total: 170475, currency: 'RUB'
  });
});

test('seller economics uses actual cost before packed quote before checkout estimate', () => {
  const base = { total: 149900, currency: 'RUB', sellerNetAmountKopecks: 149900,
    deliveryChargedToBuyerKopecks: 0, checkoutDeliveryEstimateKopecks: 20475 };
  assert.equal(financialsForSeller(base).sellerNetAfterDeliveryAmount, 129425);
  assert.equal(financialsForSeller({ ...base, packedDeliveryAmountKopecks: 24700 }).sellerNetAfterDeliveryAmount, 125200);
  assert.equal(financialsForSeller({ ...base, packedDeliveryAmountKopecks: 24700,
    actualDeliveryAmountKopecks: 26100 }).sellerNetAfterDeliveryAmount, 123800);
});

test('seller economics exposes a negative margin without claiming it as a payout', () => {
  const financials = financialsForSeller({ total: 10000, currency: 'RUB', sellerNetAmountKopecks: 9000,
    deliveryChargedToBuyerKopecks: 0, checkoutDeliveryEstimateKopecks: 11000 });
  assert.equal(financials.sellerNetAfterDeliveryAmount, -2000);
});
