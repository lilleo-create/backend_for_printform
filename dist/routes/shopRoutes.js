"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shopRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const rateLimiters_1 = require("../middleware/rateLimiters");
exports.shopRoutes = (0, express_1.Router)();
const paramsSchema = zod_1.z.object({
    shopId: zod_1.z.string().min(1)
});
exports.shopRoutes.get('/:shopId', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const { shopId } = paramsSchema.parse(req.params);
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: shopId },
            include: { sellerProfile: true }
        });
        if (!user?.sellerProfile) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        const ratingSummary = await prisma_1.prisma.product.aggregate({
            where: { sellerId: shopId, moderationStatus: 'APPROVED' },
            _avg: { ratingAvg: true },
            _sum: { ratingCount: true }
        });
        const profile = user.sellerProfile;
        const shop = {
            id: user.id,
            title: profile.storeName || user.name,
            avatarUrl: null,
            rating: ratingSummary._avg.ratingAvg ?? null,
            reviewsCount: ratingSummary._sum.ratingCount ?? null,
            subscribersCount: null,
            ordersCount: null,
            addressSlug: shopId,
            legalInfo: {
                name: profile.storeName || user.name,
                status: profile.status,
                phone: profile.phone,
                city: profile.city,
                referenceCategory: profile.referenceCategory,
                catalogPosition: profile.catalogPosition
            }
        };
        return res.json({ data: shop });
    }
    catch (error) {
        return next(error);
    }
});
exports.shopRoutes.get('/:shopId/filters', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const { shopId } = paramsSchema.parse(req.params);
        const productWhere = { sellerId: shopId, moderationStatus: 'APPROVED' };
        const [categories, materials] = await Promise.all([
            prisma_1.prisma.product.findMany({
                where: productWhere,
                distinct: ['category'],
                select: { category: true }
            }),
            prisma_1.prisma.product.findMany({
                where: productWhere,
                distinct: ['material'],
                select: { material: true }
            })
        ]);
        res.json({
            data: {
                categories: categories.map((item) => item.category).filter(Boolean).sort(),
                materials: materials.map((item) => item.material).filter(Boolean).sort()
            }
        });
    }
    catch (error) {
        next(error);
    }
});
