import { prisma } from '../lib/prisma';
import { Prisma, ReviewReplyAuthorType, ReviewStatus, ReviewReactionType } from '@prisma/client';

type ReviewOrderBy = Prisma.ReviewOrderByWithRelationInput[];

type ListReviewOptions = {
  currentUserId?: string;
};

const sortMap = (sort: string): ReviewOrderBy => {
  switch (sort) {
    case 'helpful':
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

const reviewInclude = {
  user: { select: { id: true, name: true } },
  replies: {
    orderBy: { createdAt: 'asc' as const },
    include: {
      author: {
        select: {
          id: true,
          name: true,
          sellerProfile: {
            select: {
              storeName: true
            }
          }
        }
      }
    }
  }
};

const mapReview = (
  review: Prisma.ReviewGetPayload<{ include: typeof reviewInclude }> & {
    currentUserReaction?: ReviewReactionType | null;
  }
) => ({
  id: review.id,
  productId: review.productId,
  rating: review.rating,
  pros: review.pros,
  cons: review.cons,
  comment: review.comment,
  photos: review.photos,
  likesCount: review.likesCount,
  dislikesCount: review.dislikesCount,
  isPublic: review.isPublic,
  status: review.status,
  moderationStatus: review.moderationStatus,
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
  user: review.user
    ? {
        id: review.user.id,
        nickname: review.user.name
      }
    : null,
  currentUserReaction: review.currentUserReaction ?? null,
  repliesCount: review.replies.length,
  replies: review.replies.map((reply) => ({
    id: reply.id,
    reviewId: reply.reviewId,
    authorType: reply.authorType,
    text: reply.text,
    createdAt: reply.createdAt,
    updatedAt: reply.updatedAt,
    author: {
      id: reply.author?.id ?? null,
      displayName:
        reply.authorType === 'SELLER'
          ? (reply.author?.sellerProfile?.storeName ?? reply.author?.name ?? 'Магазин')
          : (reply.author?.name ?? 'Пользователь')
    }
  }))
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

  async listByProducts(productIds: string[], page = 1, limit = 5, sort = 'new', options: ListReviewOptions = {}) {
    const reviews = await prisma.review.findMany({
      where: buildWhere(productIds),
      orderBy: sortMap(sort),
      take: limit,
      skip: (page - 1) * limit,
      include: reviewInclude
    });

    if (!options.currentUserId || reviews.length === 0) {
      return reviews.map((review) => mapReview({ ...review, currentUserReaction: null }));
    }

    const reactions = await prisma.reviewReaction.findMany({
      where: {
        userId: options.currentUserId,
        reviewId: { in: reviews.map((review) => review.id) }
      },
      select: {
        reviewId: true,
        type: true
      }
    });

    const reactionByReviewId = new Map(reactions.map((reaction) => [reaction.reviewId, reaction.type]));

    return reviews.map((review) =>
      mapReview({
        ...review,
        currentUserReaction: reactionByReviewId.get(review.id) ?? null
      })
    );
  },

  countByProducts: (productIds: string[]) => prisma.review.count({ where: buildWhere(productIds) }),

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
  },

  async setReaction(productId: string, reviewId: string, userId: string, type: ReviewReactionType) {
    return prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, productId: true }
      });

      if (!review) {
        throw new Error('NOT_FOUND');
      }
      if (review.productId !== productId) {
        throw new Error('FORBIDDEN');
      }

      const existing = await tx.reviewReaction.findUnique({
        where: { reviewId_userId: { reviewId, userId } },
        select: { id: true, type: true }
      });

      if (!existing) {
        await tx.reviewReaction.create({
          data: { reviewId, userId, type }
        });

        await tx.review.update({
          where: { id: reviewId },
          data: {
            likesCount: { increment: type === 'LIKE' ? 1 : 0 },
            dislikesCount: { increment: type === 'DISLIKE' ? 1 : 0 }
          }
        });
      } else if (existing.type !== type) {
        await tx.reviewReaction.update({
          where: { id: existing.id },
          data: { type }
        });

        await tx.review.update({
          where: { id: reviewId },
          data: {
            likesCount: { increment: type === 'LIKE' ? 1 : -1 },
            dislikesCount: { increment: type === 'DISLIKE' ? 1 : -1 }
          }
        });
      }

      const updated = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, likesCount: true, dislikesCount: true }
      });

      return {
        reviewId,
        currentUserReaction: type,
        likesCount: updated?.likesCount ?? 0,
        dislikesCount: updated?.dislikesCount ?? 0
      };
    });
  },

  async removeReaction(productId: string, reviewId: string, userId: string) {
    return prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, productId: true }
      });
      if (!review) {
        throw new Error('NOT_FOUND');
      }
      if (review.productId !== productId) {
        throw new Error('FORBIDDEN');
      }

      const existing = await tx.reviewReaction.findUnique({
        where: { reviewId_userId: { reviewId, userId } },
        select: { id: true, type: true }
      });

      if (!existing) {
        const snapshot = await tx.review.findUnique({
          where: { id: reviewId },
          select: { likesCount: true, dislikesCount: true }
        });

        if (!snapshot) {
          throw new Error('NOT_FOUND');
        }

        return {
          reviewId,
          currentUserReaction: null,
          likesCount: snapshot.likesCount,
          dislikesCount: snapshot.dislikesCount
        };
      }

      await tx.reviewReaction.delete({ where: { id: existing.id } });
      await tx.review.update({
        where: { id: reviewId },
        data: {
          likesCount: { decrement: existing.type === 'LIKE' ? 1 : 0 },
          dislikesCount: { decrement: existing.type === 'DISLIKE' ? 1 : 0 }
        }
      });

      const updated = await tx.review.findUnique({
        where: { id: reviewId },
        select: { likesCount: true, dislikesCount: true }
      });

      return {
        reviewId,
        currentUserReaction: null,
        likesCount: updated?.likesCount ?? 0,
        dislikesCount: updated?.dislikesCount ?? 0
      };
    });
  },

  async addSellerReply(productId: string, reviewId: string, authorId: string, text: string) {
    return prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: {
          id: true,
          productId: true,
          product: {
            select: {
              sellerId: true
            }
          }
        }
      });

      if (!review) {
        throw new Error('NOT_FOUND');
      }
      if (review.productId !== productId) {
        throw new Error('FORBIDDEN');
      }

      if (review.product.sellerId !== authorId) {
        throw new Error('FORBIDDEN');
      }

      const reply = await tx.reviewReply.create({
        data: {
          reviewId,
          authorId,
          authorType: ReviewReplyAuthorType.SELLER,
          text
        },
        include: {
          author: {
            select: {
              id: true,
              name: true,
              sellerProfile: {
                select: { storeName: true }
              }
            }
          }
        }
      });

      return {
        id: reply.id,
        reviewId: reply.reviewId,
        authorType: reply.authorType,
        text: reply.text,
        createdAt: reply.createdAt,
        updatedAt: reply.updatedAt,
        author: {
          id: reply.author?.id ?? null,
          displayName: reply.author?.sellerProfile?.storeName ?? reply.author?.name ?? 'Магазин'
        }
      };
    });
  }
};
