import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, type AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { prisma } from '../lib/prisma';

export const favoritesRoutes = Router();

const payloadSchema = z.object({
  productId: z.string().min(1)
});

let setupPromise: Promise<void> | null = null;

const ensureFavoritesTable = async () => {
  if (!setupPromise) {
    setupPromise = prisma
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

type FavoriteRow = {
  id: string;
  title: string;
  price: number;
  image: string | null;
  ratingAvg: number | null;
  ratingCount: number | null;
  shortSpec: string | null;
};

favoritesRoutes.get('/', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await ensureFavoritesTable();
    const rows = await prisma.$queryRawUnsafe<FavoriteRow[]>(
      `
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
      `,
      req.user!.userId
    );

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
  } catch (error) {
    next(error);
  }
});

favoritesRoutes.post('/', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    await ensureFavoritesTable();
    const payload = payloadSchema.parse(req.body);

    const product = await prisma.product.findUnique({
      where: { id: payload.productId },
      select: { id: true }
    });

    if (!product) {
      return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND' } });
    }

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO favorites (user_id, product_id)
        VALUES ($1, $2)
        ON CONFLICT (user_id, product_id) DO NOTHING
      `,
      req.user!.userId,
      payload.productId
    );

    return res.status(201).json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

favoritesRoutes.delete('/:productId', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    await ensureFavoritesTable();
    await prisma.$executeRawUnsafe(
      `DELETE FROM favorites WHERE user_id = $1 AND product_id = $2`,
      req.user!.userId,
      req.params.productId
    );
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});
