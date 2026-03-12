import { Router } from 'express';
import { z } from 'zod';
import { customRequestUseCases } from '../usecases/customRequestUseCases';
import { writeLimiter } from '../middleware/rateLimiters';

export const customRequestRoutes = Router();

const customRequestSchema = z.object({
  name: z.string().min(2),
  contact: z.string().min(3),
  comment: z.string().min(5)
});

customRequestRoutes.post('/', writeLimiter, async (req, res, next) => {
  try {
    const payload = customRequestSchema.parse(req.body);
    const request = await customRequestUseCases.create(payload);
    res.status(201).json({ data: request });
  } catch (error) {
    next(error);
  }
});
