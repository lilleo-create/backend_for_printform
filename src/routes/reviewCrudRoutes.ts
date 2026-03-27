import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { checkOwnership } from '../middleware/ownership';
import { writeLimiter } from '../middleware/rateLimiters';
import { reviewService } from '../services/reviewService';
import { sanitizeText } from '../utils/sanitize';

export const reviewCrudRoutes = Router();
export const reviewReplyCrudRoutes = Router();

const pathIdSchema = z.object({
  reviewId: z.string().trim().min(1).max(128)
});

const replyPathIdSchema = z.object({
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

const reviewUpdateSchema = z.object({
  pros: sanitizedString(3, 500).optional(),
  cons: sanitizedString(3, 500).optional(),
  comment: sanitizedString(10, 1000).optional()
});

const replyUpdateSchema = z.object({
  text: sanitizedString(1, 2000)
});

reviewCrudRoutes.patch('/:reviewId', authenticate, writeLimiter, checkOwnership('review'), async (req: AuthRequest, res, next) => {
  try {
    const { reviewId } = pathIdSchema.parse(req.params);
    const payload = reviewUpdateSchema.parse(req.body);
    const updated = await reviewService.updateReview(reviewId, req.user!.userId, payload, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: updated });
  } catch (error) {
    return next(error);
  }
});

reviewCrudRoutes.delete('/:reviewId', authenticate, writeLimiter, checkOwnership('review'), async (req: AuthRequest, res, next) => {
  try {
    const { reviewId } = pathIdSchema.parse(req.params);
    const result = await reviewService.deleteReview(reviewId, req.user!.userId, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: result });
  } catch (error) {
    return next(error);
  }
});

reviewReplyCrudRoutes.patch('/:replyId', authenticate, writeLimiter, checkOwnership('reply'), async (req: AuthRequest, res, next) => {
  try {
    const { replyId } = replyPathIdSchema.parse(req.params);
    const payload = replyUpdateSchema.parse(req.body);
    const updated = await reviewService.updateReply(replyId, req.user!.userId, payload.text, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: updated });
  } catch (error) {
    return next(error);
  }
});

reviewReplyCrudRoutes.delete('/:replyId', authenticate, writeLimiter, checkOwnership('reply'), async (req: AuthRequest, res, next) => {
  try {
    const { replyId } = replyPathIdSchema.parse(req.params);
    const result = await reviewService.deleteReply(replyId, req.user!.userId, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: result });
  } catch (error) {
    return next(error);
  }
});
