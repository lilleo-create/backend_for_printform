"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sellerProductSchema = exports.sellerProductUpdateSchema = exports.sellerProductCreateSchema = exports.productRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const productUseCases_1 = require("../usecases/productUseCases");
const reviewService_1 = require("../services/reviewService");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiters_1 = require("../middleware/rateLimiters");
const ownership_1 = require("../middleware/ownership");
const sanitize_1 = require("../utils/sanitize");
exports.productRoutes = (0, express_1.Router)();
const idParamsSchema = zod_1.z.object({
    id: zod_1.z.string().trim().min(1).max(128)
});
const reviewParamsSchema = zod_1.z.object({
    reviewId: zod_1.z.string().trim().min(1).max(128)
});
const replyParamsSchema = zod_1.z.object({
    replyId: zod_1.z.string().trim().min(1).max(128)
});
const sanitizedString = (min, max) => zod_1.z
    .string()
    .trim()
    .min(1)
    .max(max)
    .transform((value) => (0, sanitize_1.sanitizeText)(value))
    .refine((value) => value.length >= min, { message: `Must be at least ${min} characters` });
const mediaUrlSchema = zod_1.z.string().refine((value) => {
    if (value.startsWith('/uploads/')) {
        return true;
    }
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
});
const listSchema = zod_1.z.object({
    shopId: zod_1.z.string().optional(),
    q: zod_1.z.string().optional(),
    category: zod_1.z.string().optional(),
    material: zod_1.z.string().optional(),
    minPrice: zod_1.z.coerce.number().optional(),
    maxPrice: zod_1.z.coerce.number().optional(),
    sort: zod_1.z.enum(['createdAt', 'rating', 'price']).optional(),
    order: zod_1.z.enum(['asc', 'desc']).optional(),
    page: zod_1.z.coerce.number().int().positive().optional(),
    limit: zod_1.z.coerce.number().int().positive().optional()
});
exports.productRoutes.get('/', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const params = listSchema.parse(req.query);
        const products = await productUseCases_1.productUseCases.list({
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
    }
    catch (error) {
        next(error);
    }
});
exports.productRoutes.get('/:id', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const product = await productUseCases_1.productUseCases.get(req.params.id);
        if (!product) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        return res.json({ data: product });
    }
    catch (error) {
        return next(error);
    }
});
exports.productRoutes.get('/:id/variants', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const variants = await productUseCases_1.productUseCases.listVariants(req.params.id);
        if (variants === null) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        return res.json({ data: variants });
    }
    catch (error) {
        return next(error);
    }
});
const productSpecificationSchema = zod_1.z.object({
    key: zod_1.z.string().min(1),
    value: zod_1.z.string().min(1),
    sortOrder: zod_1.z.number().int().min(0).optional()
});
exports.sellerProductCreateSchema = zod_1.z.object({
    title: zod_1.z.string().min(2),
    category: zod_1.z.string().min(2),
    price: zod_1.z.preprocess((value) => (typeof value === 'string' && value.trim() !== '' ? Number(value) : value), zod_1.z.number({ invalid_type_error: 'PRICE_INVALID' }).min(1)),
    image: mediaUrlSchema.optional(),
    imageUrls: zod_1.z.array(mediaUrlSchema).optional(),
    videoUrls: zod_1.z.array(mediaUrlSchema).optional(),
    media: zod_1.z
        .array(zod_1.z.object({
        type: zod_1.z.enum(['IMAGE', 'VIDEO']),
        url: mediaUrlSchema,
        isPrimary: zod_1.z.boolean().optional(),
        sortOrder: zod_1.z.number().int().min(0).optional()
    }))
        .optional(),
    characteristics: zod_1.z.array(productSpecificationSchema).optional(),
    specifications: zod_1.z.array(productSpecificationSchema).optional(),
    description: zod_1.z.string().min(5),
    descriptionShort: zod_1.z.string().min(5).optional(),
    descriptionFull: zod_1.z.string().min(10).optional(),
    sku: zod_1.z.string().min(3).optional(),
    currency: zod_1.z.string().min(1).optional(),
    material: zod_1.z.string().min(2),
    technology: zod_1.z.string().min(2),
    printTime: zod_1.z.string().min(2).optional(),
    productionTimeHours: zod_1.z.number().int().min(1).max(720).optional(),
    color: zod_1.z.string().min(2),
    variantLabel: zod_1.z.string().min(1).max(120).optional(),
    variantSize: zod_1.z.string().min(1).max(64).optional(),
    variantAttributes: zod_1.z.record(zod_1.z.string(), zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean()])).optional(),
    weightGrossG: zod_1.z.number().int().positive().optional(),
    dxCm: zod_1.z.number().int().positive().optional(),
    dyCm: zod_1.z.number().int().positive().optional(),
    dzCm: zod_1.z.number().int().positive().optional(),
    variants: zod_1.z
        .array(zod_1.z.object({
        sku: zod_1.z.string().min(3).optional(),
        price: zod_1.z.number().int().positive().optional(),
        color: zod_1.z.string().min(2).optional(),
        variantLabel: zod_1.z.string().min(1).max(120).optional(),
        variantSize: zod_1.z.string().min(1).max(64).optional(),
        variantAttributes: zod_1.z.record(zod_1.z.string(), zod_1.z.union([zod_1.z.string(), zod_1.z.number(), zod_1.z.boolean()])).optional(),
        image: mediaUrlSchema.optional(),
        imageUrls: zod_1.z.array(mediaUrlSchema).optional(),
        videoUrls: zod_1.z.array(mediaUrlSchema).optional(),
        media: zod_1.z
            .array(zod_1.z.object({
            type: zod_1.z.enum(['IMAGE', 'VIDEO']),
            url: mediaUrlSchema,
            isPrimary: zod_1.z.boolean().optional(),
            sortOrder: zod_1.z.number().int().min(0).optional()
        }))
            .optional()
    }))
        .optional(),
});
exports.sellerProductUpdateSchema = exports.sellerProductCreateSchema.partial();
exports.sellerProductSchema = exports.sellerProductCreateSchema;
const reviewSchema = zod_1.z.object({
    rating: zod_1.z.number().int().min(1).max(5),
    pros: sanitizedString(3, 500),
    cons: sanitizedString(3, 500),
    comment: sanitizedString(10, 1000),
    photos: zod_1.z.array(mediaUrlSchema).max(5).optional()
});
const reviewListSchema = zod_1.z.object({
    page: zod_1.z.coerce.number().int().positive().default(1),
    limit: zod_1.z.coerce.number().int().positive().max(50).default(5),
    sort: zod_1.z.enum(['helpful', 'high', 'low', 'new']).default('new'),
    productIds: zod_1.z.string().optional()
});
const summaryQuerySchema = zod_1.z.object({
    productIds: zod_1.z.string().optional()
});
const reactionSchema = zod_1.z
    .object({
    type: zod_1.z.enum(['LIKE', 'DISLIKE']).optional(),
    reaction: zod_1.z.enum(['LIKE', 'DISLIKE']).optional()
})
    .superRefine((payload, ctx) => {
    if (!payload.type && !payload.reaction) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            path: ['reaction'],
            message: 'REACTION_REQUIRED'
        });
    }
})
    .transform((payload) => ({
    type: payload.type ?? payload.reaction
}));
const replySchema = zod_1.z.object({
    text: sanitizedString(1, 2000)
});
const reviewUpdateSchema = zod_1.z.object({
    pros: sanitizedString(3, 500).optional(),
    cons: sanitizedString(3, 500).optional(),
    comment: sanitizedString(10, 1000).optional()
});
exports.productRoutes.get('/:id/reviews', rateLimiters_1.publicReadLimiter, authMiddleware_1.authenticateOptional, async (req, res, next) => {
    try {
        const params = reviewListSchema.parse(req.query);
        const productIds = params.productIds
            ? params.productIds
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
            : [req.params.id];
        const reviews = await reviewService_1.reviewService.listByProducts(productIds, params.page, params.limit, params.sort, {
            currentUserId: req.user?.userId,
            isAdmin: req.user?.role === 'ADMIN'
        });
        const total = await reviewService_1.reviewService.countByProducts(productIds, {
            currentUserId: req.user?.userId,
            isAdmin: req.user?.role === 'ADMIN'
        });
        res.json({ data: reviews, meta: { total } });
    }
    catch (error) {
        next(error);
    }
});
exports.productRoutes.get('/:id/seller-summary', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const product = await productUseCases_1.productUseCases.get(req.params.id);
        if (!product) {
            return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND', message: 'Товар не найден.' } });
        }
        const seller = await reviewService_1.reviewService.getSellerSummaryByProductId(req.params.id);
        if (!seller) {
            return res.json({ data: { productId: req.params.id, seller: null } });
        }
        return res.json({ data: { productId: req.params.id, seller } });
    }
    catch (error) {
        return next(error);
    }
});
exports.productRoutes.post('/:id/reviews', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = reviewSchema.parse(req.body);
        const params = idParamsSchema.parse(req.params);
        const review = await reviewService_1.reviewService.addReview({
            productId: params.id,
            userId: req.user.userId,
            rating: payload.rating,
            pros: payload.pros,
            cons: payload.cons,
            comment: payload.comment,
            photos: payload.photos ?? []
        });
        res.status(201).json({ data: review });
    }
    catch (error) {
        next(error);
    }
});
exports.productRoutes.get('/:id/reviews/summary', rateLimiters_1.publicReadLimiter, async (req, res, next) => {
    try {
        const params = summaryQuerySchema.parse(req.query);
        const productIds = params.productIds
            ? params.productIds
                .split(',')
                .map((value) => value.trim())
                .filter(Boolean)
            : [req.params.id];
        const summary = await reviewService_1.reviewService.summaryByProducts(productIds);
        res.json({ data: summary });
    }
    catch (error) {
        next(error);
    }
});
const setReviewReactionByProductRoute = async (req, res, next) => {
    try {
        const payload = reactionSchema.parse(req.body);
        const { id, reviewId } = zod_1.z.object({ ...idParamsSchema.shape, ...reviewParamsSchema.shape }).parse(req.params);
        const reaction = await reviewService_1.reviewService.setReaction(reviewId, req.user.userId, payload.type, id);
        res.json({ data: reaction });
    }
    catch (error) {
        next(error);
    }
};
const setReviewReactionStandaloneRoute = async (req, res, next) => {
    try {
        const payload = reactionSchema.parse(req.body);
        const { reviewId } = reviewParamsSchema.parse(req.params);
        const reaction = await reviewService_1.reviewService.setReaction(reviewId, req.user.userId, payload.type);
        res.json({ data: reaction });
    }
    catch (error) {
        next(error);
    }
};
const removeReviewReactionByProductRoute = async (req, res, next) => {
    try {
        const { id, reviewId } = zod_1.z.object({ ...idParamsSchema.shape, ...reviewParamsSchema.shape }).parse(req.params);
        const reaction = await reviewService_1.reviewService.removeReaction(reviewId, req.user.userId, id);
        res.json({ data: reaction });
    }
    catch (error) {
        next(error);
    }
};
const removeReviewReactionStandaloneRoute = async (req, res, next) => {
    try {
        const { reviewId } = reviewParamsSchema.parse(req.params);
        const reaction = await reviewService_1.reviewService.removeReaction(reviewId, req.user.userId);
        res.json({ data: reaction });
    }
    catch (error) {
        next(error);
    }
};
exports.productRoutes.patch('/:id/reviews/:reviewId/reaction', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, setReviewReactionByProductRoute);
exports.productRoutes.put('/:id/reviews/:reviewId/reaction', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, setReviewReactionByProductRoute);
exports.productRoutes.patch('/reviews/:reviewId/reaction', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, setReviewReactionStandaloneRoute);
exports.productRoutes.put('/reviews/:reviewId/reaction', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, setReviewReactionStandaloneRoute);
exports.productRoutes.delete('/:id/reviews/:reviewId/reaction', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, removeReviewReactionByProductRoute);
exports.productRoutes.delete('/reviews/:reviewId/reaction', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, removeReviewReactionStandaloneRoute);
exports.productRoutes.post('/:id/reviews/:reviewId/replies', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = replySchema.parse(req.body);
        const { id, reviewId } = zod_1.z.object({ ...idParamsSchema.shape, ...reviewParamsSchema.shape }).parse(req.params);
        const reply = await reviewService_1.reviewService.addReply(reviewId, req.user.userId, payload.text, id);
        res.status(201).json({ data: reply });
    }
    catch (error) {
        next(error);
    }
});
exports.productRoutes.post('/reviews/:reviewId/replies', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = replySchema.parse(req.body);
        const { reviewId } = reviewParamsSchema.parse(req.params);
        const reply = await reviewService_1.reviewService.addReply(reviewId, req.user.userId, payload.text);
        res.status(201).json({ data: reply });
    }
    catch (error) {
        next(error);
    }
});
exports.productRoutes.patch('/reviews/:reviewId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, (0, ownership_1.checkOwnership)('review'), async (req, res, next) => {
    try {
        const payload = reviewUpdateSchema.parse(req.body);
        const { reviewId } = reviewParamsSchema.parse(req.params);
        const updated = await reviewService_1.reviewService.updateReview(reviewId, req.user.userId, payload, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: updated });
    }
    catch (error) {
        return next(error);
    }
});
exports.productRoutes.delete('/reviews/:reviewId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, (0, ownership_1.checkOwnership)('review'), async (req, res, next) => {
    try {
        const { reviewId } = reviewParamsSchema.parse(req.params);
        const result = await reviewService_1.reviewService.deleteReview(reviewId, req.user.userId, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: result });
    }
    catch (error) {
        return next(error);
    }
});
exports.productRoutes.patch('/review-replies/:replyId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, (0, ownership_1.checkOwnership)('reply'), async (req, res, next) => {
    try {
        const payload = replySchema.parse(req.body);
        const { replyId } = replyParamsSchema.parse(req.params);
        const updated = await reviewService_1.reviewService.updateReply(replyId, req.user.userId, payload.text, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: updated });
    }
    catch (error) {
        return next(error);
    }
});
exports.productRoutes.delete('/review-replies/:replyId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, (0, ownership_1.checkOwnership)('reply'), async (req, res, next) => {
    try {
        const { replyId } = replyParamsSchema.parse(req.params);
        const result = await reviewService_1.reviewService.deleteReply(replyId, req.user.userId, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: result });
    }
    catch (error) {
        return next(error);
    }
});
exports.productRoutes.all('/:id/reviews*', (_req, res) => {
    return res.status(404).json({
        error: {
            code: 'ROUTE_NOT_FOUND',
            message: 'ROUTE_NOT_FOUND'
        }
    });
});
exports.productRoutes.all('/reviews*', (_req, res) => {
    return res.status(404).json({
        error: {
            code: 'ROUTE_NOT_FOUND',
            message: 'ROUTE_NOT_FOUND'
        }
    });
});
