"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewReplyCrudRoutes = exports.reviewCrudRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const ownership_1 = require("../middleware/ownership");
const rateLimiters_1 = require("../middleware/rateLimiters");
const reviewService_1 = require("../services/reviewService");
const sanitize_1 = require("../utils/sanitize");
exports.reviewCrudRoutes = (0, express_1.Router)();
exports.reviewReplyCrudRoutes = (0, express_1.Router)();
const pathIdSchema = zod_1.z.object({
    reviewId: zod_1.z.string().trim().min(1).max(128)
});
const replyPathIdSchema = zod_1.z.object({
    replyId: zod_1.z.string().trim().min(1).max(128)
});
const sanitizedString = (min, max) => zod_1.z
    .string()
    .trim()
    .min(1)
    .max(max)
    .transform((value) => (0, sanitize_1.sanitizeText)(value))
    .refine((value) => value.length >= min, { message: `Must be at least ${min} characters` });
const reviewUpdateSchema = zod_1.z.object({
    pros: sanitizedString(3, 500).optional(),
    cons: sanitizedString(3, 500).optional(),
    comment: sanitizedString(10, 1000).optional()
});
const replyUpdateSchema = zod_1.z.object({
    text: sanitizedString(1, 2000)
});
exports.reviewCrudRoutes.patch('/:reviewId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, (0, ownership_1.checkOwnership)('review'), async (req, res, next) => {
    try {
        const { reviewId } = pathIdSchema.parse(req.params);
        const payload = reviewUpdateSchema.parse(req.body);
        const updated = await reviewService_1.reviewService.updateReview(reviewId, req.user.userId, payload, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: updated });
    }
    catch (error) {
        return next(error);
    }
});
exports.reviewCrudRoutes.delete('/:reviewId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, (0, ownership_1.checkOwnership)('review'), async (req, res, next) => {
    try {
        const { reviewId } = pathIdSchema.parse(req.params);
        const result = await reviewService_1.reviewService.deleteReview(reviewId, req.user.userId, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: result });
    }
    catch (error) {
        return next(error);
    }
});
exports.reviewReplyCrudRoutes.patch('/:replyId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, (0, ownership_1.checkOwnership)('reply'), async (req, res, next) => {
    try {
        const { replyId } = replyPathIdSchema.parse(req.params);
        const payload = replyUpdateSchema.parse(req.body);
        const updated = await reviewService_1.reviewService.updateReply(replyId, req.user.userId, payload.text, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: updated });
    }
    catch (error) {
        return next(error);
    }
});
exports.reviewReplyCrudRoutes.delete('/:replyId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, (0, ownership_1.checkOwnership)('reply'), async (req, res, next) => {
    try {
        const { replyId } = replyPathIdSchema.parse(req.params);
        const result = await reviewService_1.reviewService.deleteReply(replyId, req.user.userId, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: result });
    }
    catch (error) {
        return next(error);
    }
});
