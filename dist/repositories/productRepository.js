"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.productRepository = void 0;
const prisma_1 = require("../lib/prisma");
exports.productRepository = {
    findMany: (filters) => {
        const sortField = filters.sort === 'rating' ? 'ratingAvg' : filters.sort === 'price' ? 'price' : 'createdAt';
        const orderBy = { [sortField]: filters.order ?? 'desc' };
        const page = filters.page && filters.page > 0 ? filters.page : 1;
        const limit = filters.limit && filters.limit > 0 ? filters.limit : 12;
        const skip = (page - 1) * limit;
        return prisma_1.prisma.product.findMany({
            where: {
                sellerId: filters.shopId,
                title: filters.query
                    ? {
                        contains: filters.query,
                        mode: 'insensitive'
                    }
                    : undefined,
                category: filters.category,
                material: filters.material,
                moderationStatus: 'APPROVED',
                price: {
                    gte: filters.minPrice,
                    lte: filters.maxPrice
                }
            },
            orderBy,
            take: limit,
            skip
        });
    },
    findById: (id) => prisma_1.prisma.product.findFirst({
        where: { id, moderationStatus: 'APPROVED' },
        include: {
            images: { orderBy: { sortOrder: 'asc' } },
            variants: true,
            specs: { orderBy: { sortOrder: 'asc' } }
        }
    }),
    create: (data) => {
        const { imageUrls, videoUrls, ...rest } = data;
        return prisma_1.prisma.product.create({
            data: {
                ...rest,
                videoUrls: videoUrls ?? [],
                moderationStatus: 'PENDING',
                moderationNotes: null,
                moderatedAt: null,
                moderatedById: null,
                publishedAt: null,
                images: imageUrls?.length
                    ? {
                        create: imageUrls.map((url, index) => ({
                            url,
                            sortOrder: index
                        }))
                    }
                    : undefined
            },
            include: {
                images: { orderBy: { sortOrder: 'asc' } }
            }
        });
    },
    update: async (id, data) => {
        const { imageUrls, videoUrls, ...rest } = data;
        const moderationPatch = {
            moderationStatus: 'PENDING',
            moderationNotes: null,
            moderatedAt: null,
            moderatedById: null
        };
        const videoUrlsPatch = videoUrls !== undefined ? { videoUrls } : {};
        if (!imageUrls) {
            return prisma_1.prisma.product.update({
                where: { id },
                data: { ...rest, ...moderationPatch, ...videoUrlsPatch }
            });
        }
        return prisma_1.prisma.$transaction(async (tx) => {
            await tx.product.update({ where: { id }, data: { ...rest, ...moderationPatch, ...videoUrlsPatch } });
            await tx.productImage.deleteMany({ where: { productId: id } });
            if (imageUrls.length > 0) {
                await tx.productImage.createMany({
                    data: imageUrls.map((url, index) => ({
                        productId: id,
                        url,
                        sortOrder: index
                    }))
                });
            }
            return tx.product.findUnique({
                where: { id },
                include: { images: { orderBy: { sortOrder: 'asc' } } }
            });
        });
    },
    remove: (id) => prisma_1.prisma.product.delete({ where: { id } })
};
