import { prisma } from '../lib/prisma';
import { Prisma, ReviewStatus, ReviewReactionType } from '@prisma/client';
import { getReviewModerationStatusLabelRu } from '../utils/statusLabels';

type ReviewOrderBy = Prisma.ReviewOrderByWithRelationInput[];

type ListReviewOptions = {
  currentUserId?: string;
  isAdmin?: boolean;
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
  },
  options: ListReviewOptions = {}
) => ({
  id: review.id,
  productId: review.productId,
  authorId: review.userId,
  text: review.comment,
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
  moderationStatusLabelRu: getReviewModerationStatusLabelRu(review.moderationStatus),
  createdAt: review.createdAt,
  updatedAt: review.updatedAt,
  author: review.user
    ? {
        id: review.user.id,
        nickname: review.user.name ?? null
      }
    : null,
  user: review.user
    ? {
        id: review.user.id,
        nickname: review.user.name ?? null
      }
    : null,
  currentUserReaction: review.currentUserReaction ?? null,
  isOwn: Boolean(options.currentUserId && review.userId === options.currentUserId),
  canEdit: Boolean(options.currentUserId && (options.isAdmin || review.userId === options.currentUserId)),
  canDelete: Boolean(options.currentUserId && (options.isAdmin || review.userId === options.currentUserId)),
  repliesCount: review.replies.length,
  replies: review.replies.map((reply) => ({
    id: reply.id,
    reviewId: reply.reviewId,
    authorId: reply.authorId,
    authorType: reply.authorType,
    text: reply.text,
    createdAt: reply.createdAt,
    updatedAt: reply.updatedAt,
    author: {
      id: reply.author?.id ?? null,
      nickname: reply.author?.name ?? null,
      storeName: reply.author?.sellerProfile?.storeName ?? null,
      displayName:
        reply.authorType === 'SELLER'
          ? (reply.author?.sellerProfile?.storeName ?? reply.author?.name ?? null)
          : (reply.author?.name ?? null)
    },
    canEdit: Boolean(options.currentUserId && (options.isAdmin || reply.authorId === options.currentUserId)),
    canDelete: Boolean(options.currentUserId && (options.isAdmin || reply.authorId === options.currentUserId)),
    isOwn: Boolean(options.currentUserId && reply.authorId === options.currentUserId)
  }))
});

const mapReviewReply = (
  reply: Prisma.ReviewReplyGetPayload<{
    include: {
      author: {
        select: {
          id: true;
          name: true;
          sellerProfile: {
            select: {
              storeName: true;
            };
          };
        };
      };
      review: {
        select: {
          moderationStatus: true;
        };
      };
    };
  }>,
  options: ListReviewOptions = {}
) => ({
  id: reply.id,
  reviewId: reply.reviewId,
  authorId: reply.authorId,
  authorType: reply.authorType,
  text: reply.text,
  createdAt: reply.createdAt,
  updatedAt: reply.updatedAt,
  moderationStatus: reply.review.moderationStatus,
  moderationStatusLabelRu: getReviewModerationStatusLabelRu(reply.review.moderationStatus),
  author: {
    id: reply.author?.id ?? null,
    nickname: reply.author?.name ?? null,
    storeName: reply.author?.sellerProfile?.storeName ?? null,
    displayName:
      reply.authorType === 'SELLER'
        ? (reply.author?.sellerProfile?.storeName ?? reply.author?.name ?? null)
        : (reply.author?.name ?? null)
  },
  canEdit: Boolean(options.currentUserId && (options.isAdmin || reply.authorId === options.currentUserId)),
  canDelete: Boolean(options.currentUserId && (options.isAdmin || reply.authorId === options.currentUserId)),
  isOwn: Boolean(options.currentUserId && reply.authorId === options.currentUserId)
});

export const reviewService = {
  async getSellerSummaryByProductId(productId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, moderationStatus: 'APPROVED', deletedAt: null },
      select: {
        id: true,
        sellerId: true,
        seller: {
          select: {
            id: true,
            name: true,
            sellerProfile: { select: { storeName: true, status: true } }
          }
        }
      }
    });
    if (!product) return null;
    const stats = await prisma.product.aggregate({
      where: { sellerId: product.sellerId, moderationStatus: 'APPROVED', deletedAt: null },
      _avg: { ratingAvg: true },
      _count: { id: true }
    });
    return {
      id: product.seller.id,
      storeTitle: product.seller.sellerProfile?.storeName ?? product.seller.name,
      sellerName: product.seller.name,
      rating: stats._avg.ratingAvg ?? null,
      productsCount: stats._count.id,
      storeAvailable: product.seller.sellerProfile?.status === 'APPROVED'
    };
  },
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

      const createdReview = await tx.review.findUnique({
        where: { id: review.id },
        include: reviewInclude
      });

      if (!createdReview) throw new Error('NOT_FOUND');

      return mapReview({ ...createdReview, currentUserReaction: null }, { currentUserId: data.userId });
    });
  },

  async listByProducts(productIds: string[], page = 1, limit = 5, sort = 'new', options: ListReviewOptions = {}) {
    let authorPendingReview: Prisma.ReviewGetPayload<{ include: typeof reviewInclude }> | null = null;
    if (options.currentUserId && page === 1) {
      authorPendingReview = await prisma.review.findFirst({
        where: {
          productId: { in: productIds },
          userId: options.currentUserId,
          moderationStatus: 'PENDING'
        },
        include: reviewInclude,
        orderBy: { createdAt: 'desc' }
      });
    }

    const reviews = await prisma.review.findMany({
      where: buildWhere(productIds),
      orderBy: sortMap(sort),
      take: authorPendingReview ? Math.max(limit - 1, 0) : limit,
      skip: (page - 1) * limit,
      include: reviewInclude
    });

    const orderedReviews = authorPendingReview ? [authorPendingReview, ...reviews] : reviews;

    if (!options.currentUserId || orderedReviews.length === 0) {
      return orderedReviews.map((review) => mapReview({ ...review, currentUserReaction: null }, options));
    }

    const reactions = await prisma.reviewReaction.findMany({
      where: {
        userId: options.currentUserId,
        reviewId: { in: orderedReviews.map((review) => review.id) }
      },
      select: {
        reviewId: true,
        type: true
      }
    });

    const reactionByReviewId = new Map(reactions.map((reaction) => [reaction.reviewId, reaction.type]));

    return orderedReviews.map((review) =>
      mapReview({
        ...review,
        currentUserReaction: reactionByReviewId.get(review.id) ?? null
      }, options)
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

  async setReaction(reviewId: string, userId: string, type: ReviewReactionType, productId?: string) {
    return prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, productId: true }
      });

      if (!review) {
        throw new Error('NOT_FOUND');
      }
      if (productId && review.productId !== productId) {
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
        reactions: {
          likes: updated?.likesCount ?? 0,
          dislikes: updated?.dislikesCount ?? 0
        },
        likes: updated?.likesCount ?? 0,
        dislikes: updated?.dislikesCount ?? 0,
        likesCount: updated?.likesCount ?? 0,
        dislikesCount: updated?.dislikesCount ?? 0
      };
    });
  },

  async removeReaction(reviewId: string, userId: string, productId?: string) {
    return prisma.$transaction(async (tx) => {
      const review = await tx.review.findUnique({
        where: { id: reviewId },
        select: { id: true, productId: true }
      });
      if (!review) {
        throw new Error('NOT_FOUND');
      }
      if (productId && review.productId !== productId) {
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
          reactions: {
            likes: snapshot.likesCount,
            dislikes: snapshot.dislikesCount
          },
          likes: snapshot.likesCount,
          dislikes: snapshot.dislikesCount,
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
        reactions: {
          likes: updated?.likesCount ?? 0,
          dislikes: updated?.dislikesCount ?? 0
        },
        likes: updated?.likesCount ?? 0,
        dislikes: updated?.dislikesCount ?? 0,
        likesCount: updated?.likesCount ?? 0,
        dislikesCount: updated?.dislikesCount ?? 0
      };
    });
  },

  async addReply(reviewId: string, authorId: string, text: string, productId?: string) {
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
      if (productId && review.productId !== productId) {
        throw new Error('FORBIDDEN');
      }

      const authorType = review.product.sellerId === authorId ? 'SELLER' : 'BUYER';

      const reply = await tx.reviewReply.create({
        data: {
          reviewId,
          authorId,
          authorType,
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
          },
          review: { select: { moderationStatus: true } }
        }
      });

      return mapReviewReply(reply, { currentUserId: authorId });
    });
  }
  ,
  async updateReview(reviewId: string, actorId: string, text: { pros?: string; cons?: string; comment?: string }, isAdmin = false) {
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new Error('NOT_FOUND');
    if (!isAdmin && review.userId !== actorId) throw new Error('FORBIDDEN_REVIEW_OBJECT');
    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: {
        ...(text.pros !== undefined ? { pros: text.pros } : {}),
        ...(text.cons !== undefined ? { cons: text.cons } : {}),
        ...(text.comment !== undefined ? { comment: text.comment } : {})
      },
      include: reviewInclude
    });
    return mapReview({ ...updated, currentUserReaction: null }, { currentUserId: actorId, isAdmin });
  },
  async deleteReview(reviewId: string, actorId: string, isAdmin = false) {
    const review = await prisma.review.findUnique({ where: { id: reviewId } });
    if (!review) throw new Error('NOT_FOUND');
    if (!isAdmin && review.userId !== actorId) throw new Error('FORBIDDEN_REVIEW_OBJECT');
    await prisma.reviewReply.deleteMany({ where: { reviewId } });
    await prisma.reviewReaction.deleteMany({ where: { reviewId } });
    await prisma.review.delete({ where: { id: reviewId } });
    return { id: reviewId, deleted: true };
  },
  async updateReply(replyId: string, actorId: string, text: string, isAdmin = false) {
    const reply = await prisma.reviewReply.findUnique({ where: { id: replyId } });
    if (!reply) throw new Error('REVIEW_REPLY_NOT_FOUND');
    if (!isAdmin && reply.authorId !== actorId) throw new Error('FORBIDDEN_REVIEW_OBJECT');
    const updated = await prisma.reviewReply.update({
      where: { id: replyId },
      data: { text },
      include: {
        author: {
          select: {
            id: true,
            name: true,
            sellerProfile: { select: { storeName: true } }
          }
        },
        review: { select: { moderationStatus: true } }
      }
    });
    return mapReviewReply(updated, { currentUserId: actorId, isAdmin });
  },
  async deleteReply(replyId: string, actorId: string, isAdmin = false) {
    const reply = await prisma.reviewReply.findUnique({ where: { id: replyId } });
    if (!reply) throw new Error('REVIEW_REPLY_NOT_FOUND');
    if (!isAdmin && reply.authorId !== actorId) throw new Error('FORBIDDEN_REVIEW_OBJECT');
    await prisma.reviewReply.delete({ where: { id: replyId } });
    return { id: replyId, deleted: true };
  }
};
