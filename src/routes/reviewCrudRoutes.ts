import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { reviewService } from '../services/reviewService';

export const reviewCrudRoutes = Router();
export const reviewReplyCrudRoutes = Router();

const reviewUpdateSchema = z.object({
  pros: z.string().min(3).max(500).optional(),
  cons: z.string().min(3).max(500).optional(),
  comment: z.string().min(10).max(1000).optional()
});

const replyUpdateSchema = z.object({
  text: z.string().trim().min(1).max(2000)
});

reviewCrudRoutes.patch('/:reviewId', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = reviewUpdateSchema.parse(req.body);
    const updated = await reviewService.updateReview(req.params.reviewId, req.user!.userId, payload, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: updated });
  } catch (error) {
    return next(error);
  }
});

reviewCrudRoutes.delete('/:reviewId', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const result = await reviewService.deleteReview(req.params.reviewId, req.user!.userId, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: result });
  } catch (error) {
    return next(error);
  }
});

reviewReplyCrudRoutes.patch('/:replyId', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = replyUpdateSchema.parse(req.body);
    const updated = await reviewService.updateReply(req.params.replyId, req.user!.userId, payload.text, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: updated });
  } catch (error) {
    return next(error);
  }
});

reviewReplyCrudRoutes.delete('/:replyId', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const result = await reviewService.deleteReply(req.params.replyId, req.user!.userId, req.user!.role === 'ADMIN');
    return res.json({ ok: true, data: result });
  } catch (error) {
    return next(error);
  }
});
