"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewService = void 0;
const prisma_1 = require("../lib/prisma");
const client_1 = require("@prisma/client");
const sortMap = (sort) => {
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
const buildWhere = (productIds) => ({
    productId: { in: productIds },
    moderationStatus: 'APPROVED',
    isPublic: true
});
const reviewInclude = {
    user: { select: { id: true, name: true } },
    replies: {
        orderBy: { createdAt: 'asc' },
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
const mapReview = (review, options = {}) => ({
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
            nickname: review.user.name ?? null
        }
        : null,
    currentUserReaction: review.currentUserReaction ?? null,
    canEdit: Boolean(options.currentUserId && (options.isAdmin || review.userId === options.currentUserId)),
    canDelete: Boolean(options.currentUserId && (options.isAdmin || review.userId === options.currentUserId)),
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
            nickname: reply.author?.name ?? null,
            storeName: reply.author?.sellerProfile?.storeName ?? null,
            displayName: reply.authorType === 'SELLER'
                ? (reply.author?.sellerProfile?.storeName ?? reply.author?.name ?? null)
                : (reply.author?.name ?? null)
        },
        canEdit: Boolean(options.currentUserId && (options.isAdmin || reply.authorId === options.currentUserId)),
        canDelete: Boolean(options.currentUserId && (options.isAdmin || reply.authorId === options.currentUserId))
    }))
});
exports.reviewService = {
    async getSellerSummaryByProductId(productId) {
        const product = await prisma_1.prisma.product.findFirst({
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
        if (!product)
            return null;
        const stats = await prisma_1.prisma.product.aggregate({
            where: { sellerId: product.sellerId, moderationStatus: 'APPROVED', deletedAt: null },
            _avg: { ratingAvg: true },
            _count: { id: true }
        });
        return {
            id: product.seller.id,
            title: product.seller.sellerProfile?.storeName ?? product.seller.name,
            rating: stats._avg.ratingAvg ?? null,
            productsCount: stats._count.id,
            storeAvailable: product.seller.sellerProfile?.status === 'APPROVED'
        };
    },
    async addReview(data) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const product = await tx.product.findUnique({
                where: { id: data.productId },
                select: { id: true }
            });
            if (!product)
                throw new Error('NOT_FOUND');
            const review = await tx.review.create({
                data: {
                    productId: data.productId,
                    userId: data.userId,
                    rating: data.rating,
                    pros: data.pros,
                    cons: data.cons,
                    comment: data.comment,
                    photos: data.photos,
                    status: client_1.ReviewStatus.PENDING,
                    moderationStatus: 'PENDING',
                    moderationNotes: null,
                    moderatedAt: null,
                    moderatedById: null
                }
            });
            return review;
        });
    },
    async listByProducts(productIds, page = 1, limit = 5, sort = 'new', options = {}) {
        const reviews = await prisma_1.prisma.review.findMany({
            where: buildWhere(productIds),
            orderBy: sortMap(sort),
            take: limit,
            skip: (page - 1) * limit,
            include: reviewInclude
        });
        if (!options.currentUserId || reviews.length === 0) {
            return reviews.map((review) => mapReview({ ...review, currentUserReaction: null }, options));
        }
        const reactions = await prisma_1.prisma.reviewReaction.findMany({
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
        return reviews.map((review) => mapReview({
            ...review,
            currentUserReaction: reactionByReviewId.get(review.id) ?? null
        }, options));
    },
    countByProducts: (productIds) => prisma_1.prisma.review.count({ where: buildWhere(productIds) }),
    async summaryByProducts(productIds) {
        const grouped = await prisma_1.prisma.review.groupBy({
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
        const photos = (await prisma_1.prisma.review.findMany({
            where: buildWhere(productIds),
            select: { photos: true }
        })).flatMap((review) => review.photos ?? []);
        return { total, avg, counts, photos };
    },
    listByUser: (userId) => prisma_1.prisma.review.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }],
        include: { product: { select: { id: true, title: true, image: true } } }
    }),
    async updateVisibility(id, userId, isPublic) {
        const review = await prisma_1.prisma.review.findFirst({ where: { id, userId } });
        if (!review)
            throw new Error('NOT_FOUND');
        return prisma_1.prisma.review.update({
            where: { id },
            data: { isPublic }
        });
    },
    async setReaction(reviewId, userId, type, productId) {
        return prisma_1.prisma.$transaction(async (tx) => {
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
            }
            else if (existing.type !== type) {
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
    async removeReaction(reviewId, userId, productId) {
        return prisma_1.prisma.$transaction(async (tx) => {
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
    async addReply(reviewId, authorId, text, productId) {
        return prisma_1.prisma.$transaction(async (tx) => {
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
                    nickname: reply.author?.name ?? null,
                    storeName: reply.author?.sellerProfile?.storeName ?? null,
                    displayName: reply.authorType === 'SELLER'
                        ? (reply.author?.sellerProfile?.storeName ?? reply.author?.name ?? null)
                        : (reply.author?.name ?? null)
                }
            };
        });
    },
    async updateReview(reviewId, actorId, text, isAdmin = false) {
        const review = await prisma_1.prisma.review.findUnique({ where: { id: reviewId } });
        if (!review)
            throw new Error('NOT_FOUND');
        if (!isAdmin && review.userId !== actorId)
            throw new Error('FORBIDDEN');
        return prisma_1.prisma.review.update({
            where: { id: reviewId },
            data: {
                ...(text.pros !== undefined ? { pros: text.pros } : {}),
                ...(text.cons !== undefined ? { cons: text.cons } : {}),
                ...(text.comment !== undefined ? { comment: text.comment } : {})
            }
        });
    },
    async deleteReview(reviewId, actorId, isAdmin = false) {
        const review = await prisma_1.prisma.review.findUnique({ where: { id: reviewId } });
        if (!review)
            throw new Error('NOT_FOUND');
        if (!isAdmin && review.userId !== actorId)
            throw new Error('FORBIDDEN');
        await prisma_1.prisma.reviewReply.deleteMany({ where: { reviewId } });
        await prisma_1.prisma.reviewReaction.deleteMany({ where: { reviewId } });
        await prisma_1.prisma.review.delete({ where: { id: reviewId } });
        return { id: reviewId, deleted: true };
    },
    async updateReply(replyId, actorId, text, isAdmin = false) {
        const reply = await prisma_1.prisma.reviewReply.findUnique({ where: { id: replyId } });
        if (!reply)
            throw new Error('NOT_FOUND');
        if (!isAdmin && reply.authorId !== actorId)
            throw new Error('FORBIDDEN');
        return prisma_1.prisma.reviewReply.update({ where: { id: replyId }, data: { text } });
    },
    async deleteReply(replyId, actorId, isAdmin = false) {
        const reply = await prisma_1.prisma.reviewReply.findUnique({ where: { id: replyId } });
        if (!reply)
            throw new Error('NOT_FOUND');
        if (!isAdmin && reply.authorId !== actorId)
            throw new Error('FORBIDDEN');
        await prisma_1.prisma.reviewReply.delete({ where: { id: replyId } });
        return { id: replyId, deleted: true };
    }
};
