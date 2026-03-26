import test from 'node:test';
import assert from 'node:assert/strict';

import { productRepository } from './productRepository';
import { prisma } from '../lib/prisma';

const mediaBaseUrl = process.env.BACKEND_URL ?? 'http://localhost:4000';

test('findById returns stable product contract with specs and normalized media fields', async () => {
  const originalFindFirst = prisma.product.findFirst;
  const originalFindMany = prisma.product.findMany;

  (prisma.product.findFirst as any) = async () => ({
    id: 'prod-1',
    variantGroupId: null,
    parentProductId: null,
    title: 'P',
    descriptionShort: 'Short',
    descriptionFull: 'Full description',
    sku: 'SKU-1',
    price: 1000,
    currency: 'RUB',
    category: 'Cat',
    image: '/uploads/fallback.jpg',
    videoUrls: [],
    description: 'Desc',
    material: 'PLA',
    technology: 'FDM',
    color: 'Black',
    weightGrossG: 150,
    dxCm: 10,
    dyCm: 11,
    dzCm: 12,
    moderationStatus: 'APPROVED',
    images: [],
    variants: [],
    specs: [{ key: 'Материал', value: 'PLA', sortOrder: 0 }],
    media: [
      { type: 'IMAGE', url: '/uploads/1.jpg', isPrimary: true, sortOrder: 0, createdAt: new Date() },
      { type: 'IMAGE', url: '/uploads/1.jpg', isPrimary: false, sortOrder: 1, createdAt: new Date() },
      { type: 'VIDEO', url: '/uploads/1.mp4', isPrimary: false, sortOrder: 2, createdAt: new Date() }
    ]
  });
  (prisma.product.findMany as any) = async () => [];

  try {
    const product = await productRepository.findById('prod-1');
    assert.ok(product);
    assert.deepEqual(product.specs, [{ key: 'Материал', value: 'PLA', sortOrder: 0 }]);
    assert.deepEqual(product.characteristics, [{ key: 'Материал', value: 'PLA', sortOrder: 0 }]);
    assert.equal(product.primaryImage, `${mediaBaseUrl}/uploads/1.jpg`);
    assert.deepEqual(product.gallery, [`${mediaBaseUrl}/uploads/1.jpg`]);
    assert.equal(product.media.length, 2);
    assert.deepEqual(product.dimensions, { weightGrossG: 150, dxCm: 10, dyCm: 11, dzCm: 12 });
  } finally {
    (prisma.product.findFirst as any) = originalFindFirst;
    (prisma.product.findMany as any) = originalFindMany;
  }
});

test('findById builds fallback characteristics from flat fields when specs are empty', async () => {
  const originalFindFirst = prisma.product.findFirst;
  const originalFindMany = prisma.product.findMany;

  (prisma.product.findFirst as any) = async () => ({
    id: 'prod-flat',
    variantGroupId: null,
    parentProductId: null,
    title: 'Flat',
    descriptionShort: 'Short',
    descriptionFull: 'Full description',
    sku: 'SKU-FLAT',
    price: 1000,
    currency: 'RUB',
    category: 'Cat',
    image: '/uploads/fallback.jpg',
    videoUrls: [],
    description: 'Desc',
    material: 'PLA',
    technology: 'FDM',
    color: 'Black',
    productionTimeHours: 24,
    weightGrossG: 150,
    dxCm: 10,
    dyCm: 11,
    dzCm: 12,
    moderationStatus: 'APPROVED',
    images: [],
    variants: [],
    specs: [],
    media: []
  });
  (prisma.product.findMany as any) = async () => [];

  try {
    const product = await productRepository.findById('prod-flat');
    assert.ok(product);
    assert.deepEqual(product.characteristics.map((item) => item.key), ['Материал', 'Технология', 'Цвет', 'Срок изготовления', 'Вес', 'Размер']);
    assert.deepEqual(product.specifications, product.characteristics);
    assert.deepEqual(product.specs, product.characteristics);
  } finally {
    (prisma.product.findFirst as any) = originalFindFirst;
    (prisma.product.findMany as any) = originalFindMany;
  }
});

test('getSellerProductForEdit returns specs contract for product and variants', async () => {
  const originalFindUnique = prisma.product.findUnique;
  const originalFindMany = prisma.product.findMany;

  (prisma.product.findUnique as any) = async () => ({
    id: 'prod-1',
    sellerId: 'seller-1',
    variantGroupId: 'group-1',
    parentProductId: null,
    title: 'Master',
    descriptionShort: 'Short',
    descriptionFull: 'Long text',
    sku: 'SKU-MASTER',
    price: 1200,
    currency: 'RUB',
    category: 'Cat',
    image: '/uploads/master.jpg',
    videoUrls: [],
    description: 'Desc',
    material: 'PLA',
    technology: 'FDM',
    color: 'White',
    moderationStatus: 'APPROVED',
    images: [],
    variants: [],
    specs: [{ key: 'Layer', value: '0.2mm', sortOrder: 0 }],
    media: [{ type: 'IMAGE', url: '/uploads/master.jpg', isPrimary: true, sortOrder: 0, createdAt: new Date() }],
    seller: {
      id: 'seller-1',
      name: 'Seller',
      email: 'seller@example.com',
      sellerProfile: { storeName: 'Print Hub', city: 'Moscow' }
    }
  });

  (prisma.product.findMany as any) = async () => [
    {
      id: 'prod-2',
      sellerId: 'seller-1',
      variantGroupId: 'group-1',
      parentProductId: 'prod-1',
      title: 'Variant',
      descriptionShort: 'Short',
      descriptionFull: 'Long text',
      sku: 'SKU-VAR',
      price: 1300,
      currency: 'RUB',
      category: 'Cat',
      image: '/uploads/variant.jpg',
      videoUrls: [],
      description: 'Desc',
      material: 'PLA',
      technology: 'FDM',
      color: 'Black',
      moderationStatus: 'PENDING',
      specs: [{ key: 'Layer', value: '0.1mm', sortOrder: 0 }],
      media: [{ type: 'IMAGE', url: '/uploads/variant.jpg', isPrimary: true, sortOrder: 0, createdAt: new Date() }]
    }
  ];

  try {
    const result = await productRepository.getSellerProductForEdit('prod-1', 'seller-1');
    assert.equal(result.code, 'OK');
    assert.ok(result.data);
    assert.deepEqual(result.data.specs, [{ key: 'Layer', value: '0.2mm', sortOrder: 0 }]);
    assert.deepEqual(result.data.characteristics, [{ key: 'Layer', value: '0.2mm', sortOrder: 0 }]);
    assert.deepEqual(result.data.variants[0].specs, [{ key: 'Layer', value: '0.1mm', sortOrder: 0 }]);
    assert.deepEqual(result.data.variants[0].characteristics, [{ key: 'Layer', value: '0.1mm', sortOrder: 0 }]);
  } finally {
    (prisma.product.findUnique as any) = originalFindUnique;
    (prisma.product.findMany as any) = originalFindMany;
  }
});
