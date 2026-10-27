import test from 'node:test';
import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma';
import { productRepository } from './productRepository';

test('catalog uses IN within category, material and color and AND across groups', async () => {
  const originalCount = prisma.product.count;
  const originalFindMany = prisma.product.findMany;
  const wheres: any[] = [];
  (prisma.product.count as any) = async ({ where }: any) => { wheres.push(where); return 0; };
  (prisma.product.findMany as any) = async ({ where }: any) => { wheres.push(where); return []; };
  try {
    await productRepository.findMany({
      categories: ['Decor', 'Miniatures'], materials: ['PLA', 'PETG'], colors: ['Black', 'White']
    });
    for (const where of wheres) {
      assert.deepEqual(where.category, { in: ['Decor', 'Miniatures'] });
      assert.deepEqual(where.material, { in: ['PLA', 'PETG'] });
      assert.deepEqual(where.color, { in: ['Black', 'White'] });
    }
  } finally {
    (prisma.product.count as any) = originalCount;
    (prisma.product.findMany as any) = originalFindMany;
  }
});
