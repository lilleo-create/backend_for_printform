import test from 'node:test';
import assert from 'node:assert/strict';
import { sellerProductCreateSchema, sellerProductUpdateSchema } from './productRoutes';

const validProduct = {
  title: 'Test product',
  category: 'Models',
  price: 100,
  description: 'Product description',
  descriptionFull: 'Full product description',
  sku: 'SKU-001',
  material: 'PLA',
  technology: 'FDM',
  color: 'White',
  weightGrossG: 500,
  dxCm: 10,
  dyCm: 10,
  dzCm: 10,
};

test('seller product dimensions accept positive decimal centimetres', () => {
  const result = sellerProductCreateSchema.safeParse({
    ...validProduct,
    dxCm: 5.5,
    dyCm: 12.3,
    dzCm: 0.1,
  });

  assert.equal(result.success, true);
  if (result.success) {
    assert.deepEqual(
      { dxCm: result.data.dxCm, dyCm: result.data.dyCm, dzCm: result.data.dzCm },
      { dxCm: 5.5, dyCm: 12.3, dzCm: 0.1 },
    );
  }
  assert.equal(sellerProductUpdateSchema.safeParse({ dxCm: 5.5 }).success, true);
});

test('seller product dimensions reject zero and negative values', () => {
  for (const dimensions of [
    { dxCm: 0, dyCm: 1, dzCm: 1 },
    { dxCm: 1, dyCm: -0.1, dzCm: 1 },
    { dxCm: 1, dyCm: 1, dzCm: 0 },
  ]) {
    assert.equal(sellerProductCreateSchema.safeParse({ ...validProduct, ...dimensions }).success, false);
  }
});

test('seller product create requires weight and every dimension', () => {
  for (const field of ['weightGrossG', 'dxCm', 'dyCm', 'dzCm'] as const) {
    const product = { ...validProduct };
    delete (product as Partial<typeof validProduct>)[field];
    const result = sellerProductCreateSchema.safeParse(product);
    assert.equal(result.success, false, `${field} must be required`);
  }
  assert.equal(sellerProductCreateSchema.safeParse({ ...validProduct, weightGrossG: 0 }).success, false);
  assert.equal(sellerProductCreateSchema.safeParse({ ...validProduct, weightGrossG: 1.5 }).success, false);
});

test('seller product update remains partial after create requirements', () => {
  assert.equal(sellerProductUpdateSchema.safeParse({ title: 'Updated title' }).success, true);
  assert.equal(sellerProductUpdateSchema.safeParse({ dxCm: 5.5 }).success, true);
  assert.equal(sellerProductCreateSchema.safeParse({ ...validProduct, dxCm: 5.5, dyCm: 12.3, dzCm: 0.1 }).success, true);
});
