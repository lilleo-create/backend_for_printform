"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewService = void 0;
const prisma_1 = require("../lib/prisma");
const client_1 = require("@prisma/client");
const sortMap = (sort) => {
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
const buildWhere = (productIds) => ({
    productId: { in: productIds },
    moderationStatus: 'APPROVED',
    isPublic: true
});
exports.reviewService = {
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
    listByProduct: (productId, page = 1, limit = 5, sort = 'new') => prisma_1.prisma.review.findMany({
        where: buildWhere([productId]),
        orderBy: sortMap(sort),
        take: limit,
        skip: (page - 1) * limit,
        include: { user: { select: { id: true, name: true } } }
    }),
    listByProducts: (productIds, page = 1, limit = 5, sort = 'new') => prisma_1.prisma.review.findMany({
        where: buildWhere(productIds),
        orderBy: sortMap(sort),
        take: limit,
        skip: (page - 1) * limit,
        include: { user: { select: { id: true, name: true } } }
    }),
    countByProduct: (productId) => prisma_1.prisma.review.count({ where: buildWhere([productId]) }),
    countByProducts: (productIds) => prisma_1.prisma.review.count({ where: buildWhere(productIds) }),
    async summaryByProduct(productId) {
        const grouped = await prisma_1.prisma.review.groupBy({
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
        const photos = (await prisma_1.prisma.review.findMany({
            where: buildWhere([productId]),
            select: { photos: true }
        })).flatMap((review) => review.photos ?? []);
        return { total, avg, counts, photos };
    },
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
    }
};
