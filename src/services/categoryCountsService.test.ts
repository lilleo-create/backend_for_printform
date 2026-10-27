import test from 'node:test';
import assert from 'node:assert/strict';
import { listReferenceCategoryCounts } from './categoryCountsService';

test('counts only approved, undeleted root products and includes empty active categories', async () => {
  const categories = [
    { id: 'a', slug: 'decor', title: 'Декор' },
    { id: 'b', slug: 'figures', title: 'Фигурки' },
    { id: 'c', slug: 'empty', title: 'Пустая' }
  ];
  const products = [
    { category: 'Декор', moderationStatus: 'APPROVED', deletedAt: null, parentProductId: null },
    { category: 'Декор', moderationStatus: 'APPROVED', deletedAt: null, parentProductId: null },
    { category: 'Фигурки', moderationStatus: 'APPROVED', deletedAt: null, parentProductId: null },
    { category: 'Декор', moderationStatus: 'PENDING', deletedAt: null, parentProductId: null },
    { category: 'Декор', moderationStatus: 'ARCHIVED', deletedAt: null, parentProductId: null },
    { category: 'Декор', moderationStatus: 'DRAFT', deletedAt: null, parentProductId: null },
    { category: 'Декор', moderationStatus: 'REJECTED', deletedAt: null, parentProductId: null },
    { category: 'Декор', moderationStatus: 'NEEDS_EDIT', deletedAt: null, parentProductId: null },
    { category: 'Декор', moderationStatus: 'APPROVED', deletedAt: new Date(), parentProductId: null },
    { category: 'Декор', moderationStatus: 'APPROVED', deletedAt: null, parentProductId: 'parent' }
  ];
  let categoryCalls = 0;
  let groupCalls = 0;
  const db = {
    referenceCategory: { findMany: async (query: any) => {
      categoryCalls++;
      assert.deepEqual(query.where, { isActive: true });
      return categories;
    } },
    product: { groupBy: async (query: any) => {
      groupCalls++;
      assert.deepEqual(query.by, ['category']);
      assert.deepEqual(query.where, {
        moderationStatus: 'APPROVED', deletedAt: null, parentProductId: null,
        category: { in: categories.map((category) => category.title) }
      });
      const counts = new Map<string, number>();
      for (const product of products) {
        if (product.moderationStatus !== query.where.moderationStatus ||
          product.deletedAt !== query.where.deletedAt ||
          product.parentProductId !== query.where.parentProductId ||
          !query.where.category.in.includes(product.category)) continue;
        counts.set(product.category, (counts.get(product.category) ?? 0) + 1);
      }
      return [...counts].map(([category, count]) => ({ category, _count: { _all: count } }));
    } }
  };
  assert.deepEqual(await listReferenceCategoryCounts(db as any), [
    { ...categories[0], productsCount: 2 },
    { ...categories[1], productsCount: 1 },
    { ...categories[2], productsCount: 0 }
  ]);
  assert.equal(categoryCalls, 1);
  assert.equal(groupCalls, 1);
});
