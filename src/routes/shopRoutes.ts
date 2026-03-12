import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { publicReadLimiter } from '../middleware/rateLimiters';

export const shopRoutes = Router();

const paramsSchema = z.object({
  shopId: z.string().min(1)
});

shopRoutes.get('/:shopId', publicReadLimiter, async (req, res, next) => {
  try {
    const { shopId } = paramsSchema.parse(req.params);
    const user = await prisma.user.findUnique({
      where: { id: shopId },
      include: { sellerProfile: true }
    });
    if (!user?.sellerProfile) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    const ratingSummary = await prisma.product.aggregate({
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
  } catch (error) {
    return next(error);
  }
});

shopRoutes.get('/:shopId/filters', publicReadLimiter, async (req, res, next) => {
  try {
    const { shopId } = paramsSchema.parse(req.params);
    const productWhere = { sellerId: shopId, moderationStatus: 'APPROVED' } as const;
    const [categories, materials] = await Promise.all([
      prisma.product.findMany({
        where: productWhere,
        distinct: ['category'],
        select: { category: true }
      }),
      prisma.product.findMany({
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
  } catch (error) {
    next(error);
  }
});
