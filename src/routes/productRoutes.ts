import { Router } from 'express';
import { z } from 'zod';
import { productUseCases } from '../usecases/productUseCases';
import { reviewService } from '../services/reviewService';
import { authenticate, authenticateOptional, AuthRequest } from '../middleware/authMiddleware';
import { publicReadLimiter, writeLimiter } from '../middleware/rateLimiters';
import { checkOwnership } from '../middleware/ownership';
import { sanitizeText } from '../utils/sanitize';

export const productRoutes = Router();


const idParamsSchema = z.object({
  id: z.string().trim().min(1).max(128)
});

const reviewParamsSchema = z.object({
  reviewId: z.string().trim().min(1).max(128)
});

const replyParamsSchema = z.object({
  replyId: z.string().trim().min(1).max(128)
});

const sanitizedString = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .transform((value) => sanitizeText(value))
    .refine((value) => value.length >= min, { message: `Must be at least ${min} characters` });

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
  minPrice: z.coerce.number().int().optional(),
  maxPrice: z.coerce.number().int().optional(),
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
    z.number({ invalid_type_error: 'PRICE_INVALID' }).int('PRICE_MUST_BE_INTEGER_MINOR_UNITS').min(1)
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
        sku: z.string().min(3).optional(),
        price: z.number().int('PRICE_MUST_BE_INTEGER_MINOR_UNITS').positive().optional(),
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
  pros: sanitizedString(3, 500),
  cons: sanitizedString(3, 500),
  comment: sanitizedString(10, 1000),
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

const reactionSchema = z
  .object({
    type: z.enum(['LIKE', 'DISLIKE']).optional(),
    reaction: z.enum(['LIKE', 'DISLIKE']).optional()
  })
  .superRefine((payload, ctx) => {
    if (!payload.type && !payload.reaction) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reaction'],
        message: 'REACTION_REQUIRED'
      });
    }
  })
  .transform((payload) => ({
    type: payload.type ?? payload.reaction!
  }));

const replySchema = z.object({
  text: sanitizedString(1, 2000)
});
const reviewUpdateSchema = z.object({
  pros: sanitizedString(3, 500).optional(),
  cons: sanitizedString(3, 500).optional(),
  comment: sanitizedString(10, 1000).optional()
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
      currentUserId: req.user?.userId,
      isAdmin: req.user?.role === 'ADMIN'
    });
    const total = await reviewService.countByProducts(productIds, {
      currentUserId: req.user?.userId,
      isAdmin: req.user?.role === 'ADMIN'
    });
    res.json({ data: reviews, meta: { total } });
  } catch (error) {
    console.error('[productRoutes.GET /:id/reviews] failed', {
      endpoint: 'GET /products/:id/reviews',
      productId: req.params.id,
      productIds: typeof req.query.productIds === 'string' ? req.query.productIds : null,
      userId: req.user?.userId ?? null,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    });
    next(error);
  }
});

productRoutes.get('/:id/seller-summary', publicReadLimiter, async (req, res, next) => {
  try {
    const product = await productUseCases.get(req.params.id);
    if (!product) {
      return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND', message: 'Товар не найден.' } });
    }
    const seller = await reviewService.getSellerSummaryByProductId(req.params.id);
    if (!seller) {
      return res.json({ data: { productId: req.params.id, seller: null } });
    }
    return res.json({ data: { productId: req.params.id, seller } });
  } catch (error) {
    return next(error);
  }
});

productRoutes.post('/:id/reviews', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = reviewSchema.parse(req.body);
    const params = idParamsSchema.parse(req.params);
    const review = await reviewService.addReview({
      productId: params.id,
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

const setReviewReactionByProductRoute = async (req: AuthRequest, res: any, next: any) => {
  try {
    const payload = reactionSchema.parse(req.body);
    const { id, reviewId } = z.object({ ...idParamsSchema.shape, ...reviewParamsSchema.shape }).parse(req.params);
    const reaction = await reviewService.setReaction(reviewId, req.user!.userId, payload.type, id);
    res.json({ data: reaction });
  } catch (error) {
    next(error);
  }
};

const setReviewReactionStandaloneRoute = async (req: AuthRequest, res: any, next: any) => {
  try {
    const payload = reactionSchema.parse(req.body);
    const { reviewId } = reviewParamsSchema.parse(req.params);
    const reaction = await reviewService.setReaction(reviewId, req.user!.userId, payload.type);
    res.json({ data: reaction });
  } catch (error) {
    next(error);
  }
};

const removeReviewReactionByProductRoute = async (req: AuthRequest, res: any, next: any) => {
  try {
    const { id, reviewId } = z.object({ ...idParamsSchema.shape, ...reviewParamsSchema.shape }).parse(req.params);
    const reaction = await reviewService.removeReaction(reviewId, req.user!.userId, id);
    res.json({ data: reaction });
  } catch (error) {
    next(error);
  }
};

const removeReviewReactionStandaloneRoute = async (req: AuthRequest, res: any, next: any) => {
  try {
    const { reviewId } = reviewParamsSchema.parse(req.params);
    const reaction = await reviewService.removeReaction(reviewId, req.user!.userId);
    res.json({ data: reaction });
  } catch (error) {
    next(error);
  }
};

productRoutes.patch('/:id/reviews/:reviewId/reaction', authenticate, writeLimiter, setReviewReactionByProductRoute);
productRoutes.put('/:id/reviews/:reviewId/reaction', authenticate, writeLimiter, setReviewReactionByProductRoute);
productRoutes.patch('/reviews/:reviewId/reaction', authenticate, writeLimiter, setReviewReactionStandaloneRoute);
productRoutes.put('/reviews/:reviewId/reaction', authenticate, writeLimiter, setReviewReactionStandaloneRoute);
productRoutes.delete('/:id/reviews/:reviewId/reaction', authenticate, writeLimiter, removeReviewReactionByProductRoute);
productRoutes.delete('/reviews/:reviewId/reaction', authenticate, writeLimiter, removeReviewReactionStandaloneRoute);

productRoutes.post('/:id/reviews/:reviewId/replies', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = replySchema.parse(req.body);
    const { id, reviewId } = z.object({ ...idParamsSchema.shape, ...reviewParamsSchema.shape }).parse(req.params);
    const reply = await reviewService.addReply(reviewId, req.user!.userId, payload.text, id);
    res.status(201).json({ data: reply });
  } catch (error) {
    next(error);
  }
});

productRoutes.post('/reviews/:reviewId/replies', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = replySchema.parse(req.body);
    const { reviewId } = reviewParamsSchema.parse(req.params);
    const reply = await reviewService.addReply(reviewId, req.user!.userId, payload.text);
    res.status(201).json({ data: reply });
  } catch (error) {
    next(error);
  }
});

productRoutes.patch('/reviews/:reviewId', authenticate, writeLimiter, checkOwnership('review'), async (req: AuthRequest, res, next) => {
  try {
    const payload = reviewUpdateSchema.parse(req.body);
    const { reviewId } = reviewParamsSchema.parse(req.params);
    const updated = await reviewService.updateReview(reviewId, req.user!.userId, payload, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: updated });
  } catch (error) {
    return next(error);
  }
});

productRoutes.delete('/reviews/:reviewId', authenticate, writeLimiter, checkOwnership('review'), async (req: AuthRequest, res, next) => {
  try {
    const { reviewId } = reviewParamsSchema.parse(req.params);
    const result = await reviewService.deleteReview(reviewId, req.user!.userId, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: result });
  } catch (error) {
    return next(error);
  }
});

productRoutes.patch('/review-replies/:replyId', authenticate, writeLimiter, checkOwnership('reply'), async (req: AuthRequest, res, next) => {
  try {
    const payload = replySchema.parse(req.body);
    const { replyId } = replyParamsSchema.parse(req.params);
    const updated = await reviewService.updateReply(replyId, req.user!.userId, payload.text, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: updated });
  } catch (error) {
    return next(error);
  }
});

productRoutes.delete('/review-replies/:replyId', authenticate, writeLimiter, checkOwnership('reply'), async (req: AuthRequest, res, next) => {
  try {
    const { replyId } = replyParamsSchema.parse(req.params);
    const result = await reviewService.deleteReply(replyId, req.user!.userId, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: result });
  } catch (error) {
    return next(error);
  }
});

productRoutes.all('/:id/reviews*', (_req, res) => {
  return res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: 'ROUTE_NOT_FOUND'
    }
  });
});

productRoutes.all('/reviews*', (_req, res) => {
  return res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: 'ROUTE_NOT_FOUND'
    }
  });
});
