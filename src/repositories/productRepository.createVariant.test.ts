import test from 'node:test';
import assert from 'node:assert/strict';

import { productRepository } from './productRepository';
import { prisma } from '../lib/prisma';

test('createVariant maps client payload to Prisma contract without imageUrls/videoUrls/media fields', async () => {
  const originalFindFirst = prisma.product.findFirst;
  const originalCreate = prisma.product.create;

  let prismaCreateData: any = null;

  (prisma.product.findFirst as any) = async ({ where }: any) => {
    if (where?.id === 'master-1' && where?.sellerId === 'seller-1') {
      return { id: 'master-1', sellerId: 'seller-1', variantGroupId: null };
    }
    return null;
  };

  (prisma.product.create as any) = async ({ data }: any) => {
    prismaCreateData = data;
    return {
      id: 'variant-1',
      ...data,
      media: [],
      images: [],
      variants: [],
      specs: []
    };
  };

  try {
    await productRepository.createVariant('master-1', 'seller-1', {
      title: 'Variant',
      category: 'Category',
      price: 1200,
      image: '/uploads/v1.jpg',
      imageUrls: ['/uploads/v1.jpg', '/uploads/v2.jpg'],
      videoUrls: ['/uploads/v1.mp4'],
      media: [
        { type: 'IMAGE', url: '/uploads/v1.jpg', isPrimary: true },
        { type: 'VIDEO', url: '/uploads/v1.mp4' }
      ],
      description: 'Описание варианта',
      descriptionShort: 'Коротко',
      descriptionFull: 'Полное описание варианта',
      sku: 'SKU-TEST-1',
      currency: 'RUB',
      material: 'PLA',
      technology: 'FDM',
      color: 'White'
    });

    assert.ok(prismaCreateData);
    assert.equal('imageUrls' in prismaCreateData, false);
    assert.equal('videoUrls' in prismaCreateData, true);
    assert.equal('media' in prismaCreateData, true);
    assert.equal(prismaCreateData.parentProductId, 'master-1');
    assert.equal(prismaCreateData.variantGroupId, 'master-1');
  } finally {
    (prisma.product.findFirst as any) = originalFindFirst;
    (prisma.product.create as any) = originalCreate;
  }
});
