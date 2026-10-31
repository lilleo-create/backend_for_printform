import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { productRepository } from './productRepository';

test('new product gets a system PF article even when caller supplies legacy sku', async () => {
  const originalCounter = prisma.printFormArticleCounter.update;
  const originalCreate = prisma.product.create;
  let inserted: any;
  try {
    (prisma.printFormArticleCounter.update as any) = async () => ({ lastValue: 5 });
    (prisma.product.create as any) = async ({ data }: any) => {
      inserted = data;
      return { id: 'product-5', ...data, images: [], media: [], specs: [], variants: [] };
    };
    await productRepository.create({
      title: 'Product', category: 'Decor', price: 100000, image: '/uploads/p.jpg',
      description: 'Description', descriptionShort: 'Short', descriptionFull: 'Full description',
      sku: 'SKU-manual', currency: 'RUB', material: 'PLA', technology: 'FDM', color: 'Black',
      sellerId: 'seller-1'
    });
    assert.equal(inserted.sku, 'PF-000005');
  } finally {
    (prisma.printFormArticleCounter.update as any) = originalCounter;
    (prisma.product.create as any) = originalCreate;
  }
});

test('editing a product cannot change its PF article', async () => {
  const originalTransaction = prisma.$transaction;
  let updateData: any;
  try {
    (prisma.$transaction as any) = async (callback: any) => callback({
      product: {
        update: async ({ data }: any) => { updateData = data; },
        findUnique: async () => ({ id: 'product-5', title: 'Edited', sku: 'PF-000005',
          images: [], media: [], specs: [], variants: [] })
      }
    });
    await productRepository.update('product-5', { title: 'Edited', sku: 'SKU-manual' });
    assert.equal(updateData.title, 'Edited');
    assert.equal('sku' in updateData, false);
  } finally {
    (prisma.$transaction as any) = originalTransaction;
  }
});
