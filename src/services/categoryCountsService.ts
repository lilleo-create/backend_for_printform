import { prisma } from '../lib/prisma';

export const listReferenceCategoryCounts = async (db: typeof prisma = prisma) => {
  const categories = await db.referenceCategory.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    select: { id: true, slug: true, title: true }
  });
  if (categories.length === 0) return [];

  // Seller product writes normalize a reference slug/title to ReferenceCategory.title.
  // The public catalog uses the same stored title for its category filter.
  const counts = await db.product.groupBy({
    by: ['category'],
    where: {
      moderationStatus: 'APPROVED',
      deletedAt: null,
      parentProductId: null,
      category: { in: categories.map((category) => category.title) }
    },
    _count: { _all: true }
  });
  const byTitle = new Map(counts.map((row) => [row.category, row._count._all]));
  return categories.map((category) => ({
    ...category,
    productsCount: byTitle.get(category.title) ?? 0
  }));
};
