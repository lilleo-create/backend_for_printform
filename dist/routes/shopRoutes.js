"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shopRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const prisma_1 = require("../lib/prisma");
const rateLimiters_1 = require("../middleware/rateLimiters");
const authMiddleware_1 = require("../middleware/authMiddleware");
const productDto_1 = require("../utils/productDto");
exports.shopRoutes = (0, express_1.Router)();
const paramsSchema = zod_1.z.object({
    shopRef: zod_1.z.string().trim().min(1)
});
const latinize = (value) => value
    .toLowerCase()
    .replace(/ё/g, 'e')
    .replace(/ж/g, 'zh')
    .replace(/ц/g, 'ts')
    .replace(/ч/g, 'ch')
    .replace(/ш/g, 'sh')
    .replace(/щ/g, 'sch')
    .replace(/ю/g, 'yu')
    .replace(/я/g, 'ya')
    .replace(/а/g, 'a')
    .replace(/б/g, 'b')
    .replace(/в/g, 'v')
    .replace(/г/g, 'g')
    .replace(/д/g, 'd')
    .replace(/е/g, 'e')
    .replace(/з/g, 'z')
    .replace(/и/g, 'i')
    .replace(/й/g, 'y')
    .replace(/к/g, 'k')
    .replace(/л/g, 'l')
    .replace(/м/g, 'm')
    .replace(/н/g, 'n')
    .replace(/о/g, 'o')
    .replace(/п/g, 'p')
    .replace(/р/g, 'r')
    .replace(/с/g, 's')
    .replace(/т/g, 't')
    .replace(/у/g, 'u')
    .replace(/ф/g, 'f')
    .replace(/х/g, 'h')
    .replace(/ъ/g, '')
    .replace(/ы/g, 'y')
    .replace(/ь/g, '')
    .replace(/э/g, 'e');
const buildStoreSlug = (value) => latinize(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
const toShopView = (user, ratingSummary) => {
    const profile = user.sellerProfile;
    const displayName = profile.storeName || user.name;
    return {
        id: user.id,
        title: displayName,
        avatarUrl: null,
        rating: ratingSummary._avg.ratingAvg ?? null,
        reviewsCount: ratingSummary._sum.ratingCount ?? null,
        subscribersCount: null,
        ordersCount: null,
        addressSlug: buildStoreSlug(displayName) || user.id,
        isPublished: profile.status === 'APPROVED',
        legalInfo: {
            name: displayName,
            status: profile.status,
            sellerType: profile.sellerType ?? profile.legalType ?? null,
            phone: profile.phone,
            city: profile.city,
            referenceCategory: profile.referenceCategory
        }
    };
};
const resolveUserByShopRef = async (shopRef, options) => {
    const byId = await prisma_1.prisma.user.findUnique({
        where: { id: shopRef },
        include: { sellerProfile: true }
    });
    if (byId?.sellerProfile) {
        return byId;
    }
    const normalizedRef = buildStoreSlug(shopRef);
    if (!normalizedRef)
        return null;
    const candidates = await prisma_1.prisma.user.findMany({
        where: {
            sellerProfile: options?.onlyPublic
                ? { is: { status: 'APPROVED' } }
                : { isNot: null }
        },
        select: {
            id: true,
            name: true,
            sellerProfile: true
        }
    });
    return candidates.find((candidate) => {
        if (!candidate.sellerProfile)
            return false;
        const slug = buildStoreSlug(candidate.sellerProfile.storeName || candidate.name);
        return slug === normalizedRef;
    }) ?? null;
};
exports.shopRoutes.get('/me', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: req.user.userId },
            include: { sellerProfile: true }
        });
        if (!user?.sellerProfile) {
            return res.status(404).json({
                error: {
                    code: 'STORE_NOT_CREATED',
                    message: 'Магазин продавца не создан. Завершите onboarding продавца.'
                }
            });
        }
        const ratingSummary = await prisma_1.prisma.product.aggregate({
            where: { sellerId: user.id, moderationStatus: 'APPROVED' },
            _avg: { ratingAvg: true },
            _sum: { ratingCount: true }
        });
        return res.json({ data: toShopView(user, ratingSummary) });
    }
    catch (error) {
        return next(error);
    }
});
exports.shopRoutes.get('/me/products', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const user = await prisma_1.prisma.user.findUnique({
            where: { id: req.user.userId },
            select: { sellerProfile: { select: { id: true } } }
        });
        if (!user?.sellerProfile) {
            return res.status(404).json({
                error: {
                    code: 'STORE_NOT_CREATED',
                    message: 'Магазин продавца не создан. Завершите onboarding продавца.'
                }
            });
        }
        const products = await prisma_1.prisma.product.findMany({
            where: { sellerId: req.user.userId, deletedAt: null },
            include: {
                images: { orderBy: { sortOrder: 'asc' } },
                media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
                specs: { orderBy: { sortOrder: 'asc' } }
            },
            orderBy: { createdAt: 'desc' }
        });
        return res.json({ data: products.map((product) => (0, productDto_1.normalizeProductDto)(product)) });
    }
    catch (error) {
        return next(error);
    }
});
exports.shopRoutes.get('/:shopRef', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const { shopRef } = paramsSchema.parse(req.params);
        const user = await resolveUserByShopRef(shopRef, { onlyPublic: true });
        if (!user?.sellerProfile) {
            return res.status(404).json({
                error: { code: 'STORE_NOT_FOUND', message: 'Публичный магазин не найден по указанному id/slug.' }
            });
        }
        if (user.sellerProfile.status !== 'APPROVED') {
            return res.status(403).json({
                error: { code: 'STORE_NOT_PUBLIC', message: 'Магазин найден, но ещё не опубликован.' }
            });
        }
        const ratingSummary = await prisma_1.prisma.product.aggregate({
            where: { sellerId: user.id, moderationStatus: 'APPROVED' },
            _avg: { ratingAvg: true },
            _sum: { ratingCount: true }
        });
        return res.json({ data: toShopView(user, ratingSummary) });
    }
    catch (error) {
        return next(error);
    }
});
exports.shopRoutes.get('/:shopRef/products', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const { shopRef } = paramsSchema.parse(req.params);
        const user = await resolveUserByShopRef(shopRef, { onlyPublic: true });
        if (!user?.sellerProfile) {
            return res.status(404).json({
                error: { code: 'STORE_NOT_FOUND', message: 'Публичный магазин не найден по указанному id/slug.' }
            });
        }
        const products = await prisma_1.prisma.product.findMany({
            where: { sellerId: user.id, moderationStatus: 'APPROVED', deletedAt: null },
            include: {
                images: { orderBy: { sortOrder: 'asc' } },
                media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
                specs: { orderBy: { sortOrder: 'asc' } }
            },
            orderBy: { createdAt: 'desc' }
        });
        return res.json({ data: products.map((product) => (0, productDto_1.normalizeProductDto)(product)) });
    }
    catch (error) {
        return next(error);
    }
});
exports.shopRoutes.get('/:shopRef/filters', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const { shopRef } = paramsSchema.parse(req.params);
        const user = await resolveUserByShopRef(shopRef, { onlyPublic: true });
        if (!user?.sellerProfile) {
            return res.status(404).json({
                error: { code: 'STORE_NOT_FOUND', message: 'Публичный магазин не найден по указанному id/slug.' }
            });
        }
        const productWhere = { sellerId: user.id, moderationStatus: 'APPROVED', deletedAt: null };
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
