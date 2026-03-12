import { prisma } from '../lib/prisma';
import { Prisma, ReviewStatus } from '@prisma/client';

type ReviewOrderBy = Prisma.ReviewOrderByWithRelationInput[];

const sortMap = (sort: string): ReviewOrderBy => {
  switch (sort) {
    case 'helpful':
      // ВАЖНО: likesCount должен существовать в schema.prisma
      return [{ likesCount: 'desc' }, { createdAt: 'desc' }];
    case 'high':
      return [{ rating: 'desc' }, { createdAt: 'desc' }];
    case 'low':
      return [{ rating: 'asc' }, { createdAt: 'desc' }];
    default:
      return [{ createdAt: 'desc' }];
  }
};

const buildWhere = (productIds: string[]): Prisma.ReviewWhereInput => ({
  productId: { in: productIds },
  moderationStatus: 'APPROVED',
  isPublic: true
});

export const reviewService = {
  async addReview(data: {
    productId: string;
    userId: string;
    rating: number;
    pros: string;
    cons: string;
    comment: string;
    photos: string[];
  }) {
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: data.productId },
        select: { id: true }
      });

      if (!product) throw new Error('NOT_FOUND');

      const review = await tx.review.create({
        data: {
          productId: data.productId,
          userId: data.userId,
          rating: data.rating,
          pros: data.pros,
          cons: data.cons,
          comment: data.comment,
          photos: data.photos,
          status: ReviewStatus.PENDING,
          moderationStatus: 'PENDING',
          moderationNotes: null,
          moderatedAt: null,
          moderatedById: null
        }
      });

      return review;
    });
  },

  listByProduct: (productId: string, page = 1, limit = 5, sort = 'new') =>
    prisma.review.findMany({
      where: buildWhere([productId]),
      orderBy: sortMap(sort),
      take: limit,
      skip: (page - 1) * limit,
      include: { user: { select: { id: true, name: true } } }
    }),

  listByProducts: (productIds: string[], page = 1, limit = 5, sort = 'new') =>
    prisma.review.findMany({
      where: buildWhere(productIds),
      orderBy: sortMap(sort),
      take: limit,
      skip: (page - 1) * limit,
      include: { user: { select: { id: true, name: true } } }
    }),

  countByProduct: (productId: string) => prisma.review.count({ where: buildWhere([productId]) }),

  countByProducts: (productIds: string[]) => prisma.review.count({ where: buildWhere(productIds) }),

  async summaryByProduct(productId: string) {
    const grouped = await prisma.review.groupBy({
      by: ['rating'],
      where: buildWhere([productId]),
      _count: { _all: true }
    });

    const total = grouped.reduce((sum, item) => sum + item._count._all, 0);
    const avg = total
      ? grouped.reduce((sum, item) => sum + item.rating * item._count._all, 0) / total
      : 0;

    const counts = [5, 4, 3, 2, 1].map((value) => ({
      rating: value,
      count: grouped.find((item) => item.rating === value)?._count._all ?? 0
    }));

    const photos = (
      await prisma.review.findMany({
        where: buildWhere([productId]),
        select: { photos: true }
      })
    ).flatMap((review) => review.photos ?? []);

    return { total, avg, counts, photos };
  },

  async summaryByProducts(productIds: string[]) {
    const grouped = await prisma.review.groupBy({
      by: ['rating'],
      where: buildWhere(productIds),
      _count: { _all: true }
    });

    const total = grouped.reduce((sum, item) => sum + item._count._all, 0);
    const avg = total
      ? grouped.reduce((sum, item) => sum + item.rating * item._count._all, 0) / total
      : 0;

    const counts = [5, 4, 3, 2, 1].map((value) => ({
      rating: value,
      count: grouped.find((item) => item.rating === value)?._count._all ?? 0
    }));

    const photos = (
      await prisma.review.findMany({
        where: buildWhere(productIds),
        select: { photos: true }
      })
    ).flatMap((review) => review.photos ?? []);

    return { total, avg, counts, photos };
  },

  listByUser: (userId: string) =>
    prisma.review.findMany({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }],
      include: { product: { select: { id: true, title: true, image: true } } }
    }),

  async updateVisibility(id: string, userId: string, isPublic: boolean) {
    const review = await prisma.review.findFirst({ where: { id, userId } });
    if (!review) throw new Error('NOT_FOUND');

    return prisma.review.update({
      where: { id },
      data: { isPublic }
    });
  }
};
