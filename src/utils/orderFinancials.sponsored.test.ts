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
