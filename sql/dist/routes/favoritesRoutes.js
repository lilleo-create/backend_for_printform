"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.favoritesRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiters_1 = require("../middleware/rateLimiters");
const prisma_1 = require("../lib/prisma");
exports.favoritesRoutes = (0, express_1.Router)();
const payloadSchema = zod_1.z.object({
    productId: zod_1.z.string().min(1)
});
let setupPromise = null;
const ensureFavoritesTable = async () => {
    if (!setupPromise) {
        setupPromise = prisma_1.prisma
            .$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS favorites (
          user_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, product_id)
        )
      `)
            .then(() => undefined);
    }
    return setupPromise;
};
exports.favoritesRoutes.get('/', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        await ensureFavoritesTable();
        const rows = await prisma_1.prisma.$queryRawUnsafe(`
        SELECT
          p.id,
          p.title,
          p.price,
          p.image,
          p."ratingAvg",
          p."ratingCount",
          p."descriptionShort" AS "shortSpec"
        FROM favorites f
        INNER JOIN "Product" p ON p.id = f.product_id
        WHERE f.user_id = $1
        ORDER BY f.created_at DESC
      `, req.user.userId);
        res.json({
            items: rows.map((row) => ({
                id: row.id,
                title: row.title,
                price: Number(row.price ?? 0),
                image: row.image,
                ratingAvg: row.ratingAvg ?? undefined,
                ratingCount: row.ratingCount ?? undefined,
                shortSpec: row.shortSpec
            }))
        });
    }
    catch (error) {
        next(error);
    }
});
exports.favoritesRoutes.post('/', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        await ensureFavoritesTable();
        const payload = payloadSchema.parse(req.body);
        const product = await prisma_1.prisma.product.findUnique({
            where: { id: payload.productId },
            select: { id: true }
        });
        if (!product) {
            return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND' } });
        }
        await prisma_1.prisma.$executeRawUnsafe(`
        INSERT INTO favorites (user_id, product_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, product_id) DO NOTHING
      `, req.user.userId, payload.productId);
        return res.status(201).json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
exports.favoritesRoutes.delete('/:productId', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        await ensureFavoritesTable();
        await prisma_1.prisma.$executeRawUnsafe(`DELETE FROM favorites WHERE user_id = $1 AND product_id = $2`, req.user.userId, req.params.productId);
        res.json({ ok: true });
    }
    catch (error) {
        next(error);
    }
});
