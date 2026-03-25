import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { publicReadLimiter } from '../middleware/rateLimiters';
import { AuthRequest, requireAuth } from '../middleware/authMiddleware';

export const shopRoutes = Router();

const paramsSchema = z.object({
  shopRef: z.string().trim().min(1)
});

const latinize = (value: string) =>
  value
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

const buildStoreSlug = (value: string) =>
  latinize(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);

const toShopView = (user: { id: string; name: string; sellerProfile: any }, ratingSummary: { _avg: { ratingAvg: number | null }; _sum: { ratingCount: number | null } }) => {
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

const resolveUserByShopRef = async (shopRef: string, options?: { onlyPublic?: boolean }) => {
  const byId = await prisma.user.findUnique({
    where: { id: shopRef },
    include: { sellerProfile: true }
  });
  if (byId?.sellerProfile) {
    return byId;
  }

  const normalizedRef = buildStoreSlug(shopRef);
  if (!normalizedRef) return null;

  const candidates = await prisma.user.findMany({
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
    if (!candidate.sellerProfile) return false;
    const slug = buildStoreSlug(candidate.sellerProfile.storeName || candidate.name);
    return slug === normalizedRef;
  }) ?? null;
};

shopRoutes.get('/me', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
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

    if (user.sellerProfile.status !== 'APPROVED') {
      return res.status(409).json({
        error: {
          code: 'STORE_NOT_ACTIVE',
          message: 'Магазин найден, но ещё не активирован.'
        }
      });
    }

    const ratingSummary = await prisma.product.aggregate({
      where: { sellerId: user.id, moderationStatus: 'APPROVED' },
      _avg: { ratingAvg: true },
      _sum: { ratingCount: true }
    });

    return res.json({ data: toShopView(user, ratingSummary) });
  } catch (error) {
    return next(error);
  }
});

shopRoutes.get('/me/products', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user!.userId },
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

    const products = await prisma.product.findMany({
      where: { sellerId: req.user!.userId },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ data: products });
  } catch (error) {
    return next(error);
  }
});

shopRoutes.get('/:shopRef', publicReadLimiter, async (req, res, next) => {
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

    const ratingSummary = await prisma.product.aggregate({
      where: { sellerId: user.id, moderationStatus: 'APPROVED' },
      _avg: { ratingAvg: true },
      _sum: { ratingCount: true }
    });

    return res.json({ data: toShopView(user, ratingSummary) });
  } catch (error) {
    return next(error);
  }
});

shopRoutes.get('/:shopRef/products', publicReadLimiter, async (req, res, next) => {
  try {
    const { shopRef } = paramsSchema.parse(req.params);
    const user = await resolveUserByShopRef(shopRef, { onlyPublic: true });
    if (!user?.sellerProfile) {
      return res.status(404).json({
        error: { code: 'STORE_NOT_FOUND', message: 'Публичный магазин не найден по указанному id/slug.' }
      });
    }

    const products = await prisma.product.findMany({
      where: { sellerId: user.id, moderationStatus: 'APPROVED' },
      include: {
        images: { orderBy: { sortOrder: 'asc' } },
        media: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] }
      },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ data: products });
  } catch (error) {
    return next(error);
  }
});

shopRoutes.get('/:shopRef/filters', publicReadLimiter, async (req, res, next) => {
  try {
    const { shopRef } = paramsSchema.parse(req.params);
    const user = await resolveUserByShopRef(shopRef, { onlyPublic: true });
    if (!user?.sellerProfile) {
      return res.status(404).json({
        error: { code: 'STORE_NOT_FOUND', message: 'Публичный магазин не найден по указанному id/slug.' }
      });
    }

    const productWhere = { sellerId: user.id, moderationStatus: 'APPROVED' } as const;
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
