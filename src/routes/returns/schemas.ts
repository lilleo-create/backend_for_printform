import { z } from 'zod';

export const photoUrlSchema = z.string().superRefine((value, ctx) => {
  if (/^\/private-files\/returns\/[A-Za-z0-9_-]+\/[0-9a-f-]+\.(jpg|png|webp)$/.test(value)) {
    return;
  }
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid return photo URL' });
});

export const createReturnSchema = z.object({
  orderItemId: z.string().min(1),
  reason: z.enum(['NOT_FIT', 'DAMAGED', 'WRONG_ITEM']),
  comment: z.string().trim().min(5).max(2000),
  photosUrls: z.array(photoUrlSchema).max(10).optional().default([])
});
