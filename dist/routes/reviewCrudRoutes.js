"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.reviewReplyCrudRoutes = exports.reviewCrudRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiters_1 = require("../middleware/rateLimiters");
const reviewService_1 = require("../services/reviewService");
exports.reviewCrudRoutes = (0, express_1.Router)();
exports.reviewReplyCrudRoutes = (0, express_1.Router)();
const reviewUpdateSchema = zod_1.z.object({
    pros: zod_1.z.string().min(3).max(500).optional(),
    cons: zod_1.z.string().min(3).max(500).optional(),
    comment: zod_1.z.string().min(10).max(1000).optional()
});
const replyUpdateSchema = zod_1.z.object({
    text: zod_1.z.string().trim().min(1).max(2000)
});
exports.reviewCrudRoutes.patch('/:reviewId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = reviewUpdateSchema.parse(req.body);
        const updated = await reviewService_1.reviewService.updateReview(req.params.reviewId, req.user.userId, payload, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: updated });
    }
    catch (error) {
        return next(error);
    }
});
exports.reviewCrudRoutes.delete('/:reviewId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const result = await reviewService_1.reviewService.deleteReview(req.params.reviewId, req.user.userId, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: result });
    }
    catch (error) {
        return next(error);
    }
});
exports.reviewReplyCrudRoutes.patch('/:replyId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = replyUpdateSchema.parse(req.body);
        const updated = await reviewService_1.reviewService.updateReply(req.params.replyId, req.user.userId, payload.text, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: updated });
    }
    catch (error) {
        return next(error);
    }
});
exports.reviewReplyCrudRoutes.delete('/:replyId', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const result = await reviewService_1.reviewService.deleteReply(req.params.replyId, req.user.userId, req.user.role === 'ADMIN');
        return res.json({ ok: true, data: result });
    }
    catch (error) {
        return next(error);
    }
});
