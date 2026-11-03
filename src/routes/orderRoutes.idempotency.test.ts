import test from 'node:test';
import assert from 'node:assert/strict';
import { sameCheckout } from './orderRoutes';

test('checkout retry key cannot silently reuse an order with changed contact or address', () => {
  const saved = {
    contactId: 'contact-a', shippingAddressId: null, buyerPickupPvzId: 'PVZ-1',
    items: [{ productId: 'product-a', variantId: null, quantity: 1 }]
  };
  const request = {
    paymentAttemptKey: 'attempt-1', contactId: 'contact-a', shippingAddressId: 'cdek_pvz',
    cdekPvzCode: 'PVZ-1', items: [{ productId: 'product-a', quantity: 1 }]
  };
  assert.equal(sameCheckout(saved, request), true);
  assert.equal(sameCheckout(saved, { ...request, contactId: 'contact-b' }), false);
  assert.equal(sameCheckout(saved, { ...request, shippingAddressId: 'address-b' }), false);
  assert.equal(sameCheckout(saved, { ...request, cdekPvzCode: 'PVZ-2' }), false);
});
