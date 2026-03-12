import { z } from 'zod';

export const photoUrlSchema = z.string().superRefine((value, ctx) => {
  if (value.startsWith('/uploads/returns/')) {
    return;
  }
  try {
    new URL(value);
  } catch {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid url' });
  }
});

export const createReturnSchema = z.object({
  orderItemId: z.string().min(1),
  reason: z.enum(['NOT_FIT', 'DAMAGED', 'WRONG_ITEM']),
  comment: z.string().trim().min(5).max(2000),
  photosUrls: z.array(photoUrlSchema).max(10).optional().default([])
});
