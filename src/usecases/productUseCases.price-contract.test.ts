import test from 'node:test';
import assert from 'node:assert/strict';
import { productUseCases } from './productUseCases';
import { productRepository } from '../repositories/productRepository';

test('create keeps integer minor units price without extra conversion', async () => {
  let createdPayload: any = null;
  (productRepository.create as any) = async (payload: any) => {
    createdPayload = payload;
    return payload;
  };

  await productUseCases.create({
    title: 'Product',
    category: 'Cat',
    price: 100000,
    image: '/uploads/1.jpg',
    description: 'Description',
    descriptionShort: 'Short',
    descriptionFull: 'Full description',
    sku: 'SKU-1',
    currency: 'RUB',
    material: 'PLA',
    technology: 'FDM',
    color: 'Black',
    sellerId: 'seller-1'
  });

  assert.equal(createdPayload.price, 100000);
});

test('update keeps integer minor units price without extra conversion', async () => {
  let updatedPayload: any = null;
  (productRepository.update as any) = async (_id: string, payload: any) => {
    updatedPayload = payload;
    return payload;
  };

  await productUseCases.update('prod-1', { price: 250050 });

  assert.equal(updatedPayload.price, 250050);
});
