import { Router } from 'express';
import { z } from 'zod';
import { ReviewReactionType } from '@prisma/client';
import { productUseCases } from '../usecases/productUseCases';
import { reviewService } from '../services/reviewService';
import { authenticate, authenticateOptional, AuthRequest } from '../middleware/authMiddleware';
import { publicReadLimiter, writeLimiter } from '../middleware/rateLimiters';

export const productRoutes = Router();

const mediaUrlSchema = z.string().refine((value) => {
  if (value.startsWith('/uploads/')) {
    return true;
  }
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
});

const listSchema = z.object({
  shopId: z.string().optional(),
  q: z.string().optional(),
  category: z.string().optional(),
  material: z.string().optional(),
  minPrice: z.coerce.number().optional(),
  maxPrice: z.coerce.number().optional(),
  sort: z.enum(['createdAt', 'rating', 'price']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional()
});

productRoutes.get('/', publicReadLimiter, async (req, res, next) => {
  try {
    const params = listSchema.parse(req.query);
    const products = await productUseCases.list({
      shopId: params.shopId,
      query: params.q,
      category: params.category,
      material: params.material,
      minPrice: params.minPrice,
      maxPrice: params.maxPrice,
      sort: params.sort,
      order: params.order,
      page: params.page,
      limit: params.limit
    });
    res.json({ data: products });
  } catch (error) {
    next(error);
  }
});

productRoutes.get('/:id', publicReadLimiter, async (req, res, next) => {
  try {
    const product = await productUseCases.get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    return res.json({ data: product });
  } catch (error) {
    return next(error);
  }
});

productRoutes.get('/:id/variants', publicReadLimiter, async (req, res, next) => {
  try {
    const variants = await productUseCases.listVariants(req.params.id);
    if (variants === null) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    return res.json({ data: variants });
  } catch (error) {
    return next(error);
  }
});

const productSpecificationSchema = z.object({
  key: z.string().min(1),
  value: z.string().min(1),
  sortOrder: z.number().int().min(0).optional()
});

export const sellerProductCreateSchema = z.object({
  title: z.string().min(2),
  category: z.string().min(2),
  price: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value),
    z.number({ invalid_type_error: 'PRICE_INVALID' }).min(1)
  ),
  image: mediaUrlSchema.optional(),
  imageUrls: z.array(mediaUrlSchema).optional(),
  videoUrls: z.array(mediaUrlSchema).optional(),
  media: z
    .array(
      z.object({
        type: z.enum(['IMAGE', 'VIDEO']),
        url: mediaUrlSchema,
        isPrimary: z.boolean().optional(),
        sortOrder: z.number().int().min(0).optional()
      })
    )
    .optional(),
  characteristics: z.array(productSpecificationSchema).optional(),
  specifications: z.array(productSpecificationSchema).optional(),
  description: z.string().min(5),
  descriptionShort: z.string().min(5).optional(),
  descriptionFull: z.string().min(10).optional(),
  sku: z.string().min(3).optional(),
  currency: z.string().min(1).optional(),
  material: z.string().min(2),
  technology: z.string().min(2),
  printTime: z.string().min(2).optional(),
  productionTimeHours: z.number().int().min(1).max(720).optional(),
  color: z.string().min(2),
  variantLabel: z.string().min(1).max(120).optional(),
  variantSize: z.string().min(1).max(64).optional(),
  variantAttributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  weightGrossG: z.number().int().positive().optional(),
  dxCm: z.number().int().positive().optional(),
  dyCm: z.number().int().positive().optional(),
  dzCm: z.number().int().positive().optional(),
  variants: z
    .array(
      z.object({
        sku: z.string().min(3),
        price: z.number().int().positive().optional(),
        color: z.string().min(2).optional(),
        variantLabel: z.string().min(1).max(120).optional(),
        variantSize: z.string().min(1).max(64).optional(),
        variantAttributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        image: mediaUrlSchema.optional(),
        imageUrls: z.array(mediaUrlSchema).optional(),
        videoUrls: z.array(mediaUrlSchema).optional(),
        media: z
          .array(
            z.object({
              type: z.enum(['IMAGE', 'VIDEO']),
              url: mediaUrlSchema,
              isPrimary: z.boolean().optional(),
              sortOrder: z.number().int().min(0).optional()
            })
          )
          .optional()
      })
    )
    .optional(),
});

export const sellerProductUpdateSchema = sellerProductCreateSchema.partial();
export const sellerProductSchema = sellerProductCreateSchema;

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  pros: z.string().min(3).max(500),
  cons: z.string().min(3).max(500),
  comment: z.string().min(10).max(1000),
  // ✅ разрешаем и /uploads/..., и абсолютные http(s)
  photos: z.array(mediaUrlSchema).max(5).optional()
});

const reviewListSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(50).default(5),
  sort: z.enum(['helpful', 'high', 'low', 'new']).default('new'),
  productIds: z.string().optional()
});

const summaryQuerySchema = z.object({
  productIds: z.string().optional()
});

const reactionSchema = z.object({
  type: z.nativeEnum(ReviewReactionType)
});

const replySchema = z.object({
  text: z.string().trim().min(1).max(2000)
});

productRoutes.get('/:id/reviews', publicReadLimiter, authenticateOptional, async (req: AuthRequest, res, next) => {
  try {
    const params = reviewListSchema.parse(req.query);
    const productIds = params.productIds
      ? params.productIds
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [req.params.id];
    const reviews = await reviewService.listByProducts(productIds, params.page, params.limit, params.sort, {
      currentUserId: req.user?.userId
    });
    const total = await reviewService.countByProducts(productIds);
    res.json({ data: reviews, meta: { total } });
  } catch (error) {
    next(error);
  }
});

productRoutes.post('/:id/reviews', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = reviewSchema.parse(req.body);
    const review = await reviewService.addReview({
      productId: req.params.id,
      userId: req.user!.userId,
      rating: payload.rating,
      pros: payload.pros,
      cons: payload.cons,
      comment: payload.comment,
      photos: payload.photos ?? []
    });
    res.status(201).json({ data: review });
  } catch (error) {
    next(error);
  }
});

productRoutes.get('/:id/reviews/summary', publicReadLimiter, async (req, res, next) => {
  try {
    const params = summaryQuerySchema.parse(req.query);
    const productIds = params.productIds
      ? params.productIds
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : [req.params.id];
    const summary = await reviewService.summaryByProducts(productIds);
    res.json({ data: summary });
  } catch (error) {
    next(error);
  }
});

productRoutes.put(
  '/:id/reviews/:reviewId/reaction',
  authenticate,
  writeLimiter,
  async (req: AuthRequest, res, next) => {
    try {
      const payload = reactionSchema.parse(req.body);
      const reaction = await reviewService.setReaction(req.params.id, req.params.reviewId, req.user!.userId, payload.type);
      res.json({ data: reaction });
    } catch (error) {
      next(error);
    }
  }
);

productRoutes.delete(
  '/:id/reviews/:reviewId/reaction',
  authenticate,
  writeLimiter,
  async (req: AuthRequest, res, next) => {
    try {
      const reaction = await reviewService.removeReaction(req.params.id, req.params.reviewId, req.user!.userId);
      res.json({ data: reaction });
    } catch (error) {
      next(error);
    }
  }
);

productRoutes.post('/:id/reviews/:reviewId/replies', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = replySchema.parse(req.body);
    const reply = await reviewService.addSellerReply(req.params.id, req.params.reviewId, req.user!.userId, payload.text);
    res.status(201).json({ data: reply });
  } catch (error) {
    next(error);
  }
});
