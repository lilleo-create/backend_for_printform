import { Router } from 'express';
import { z } from 'zod';
import path from 'path';
import fs from 'fs';
import { ProductModerationStatus, ReviewModerationStatus } from '@prisma/client';
import { requireAuth, requireAdmin, AuthRequest } from '../middleware/authMiddleware';
import { prisma } from '../lib/prisma';
import { writeLimiter } from '../middleware/rateLimiters';
import { notFound } from '../utils/httpErrors';
import { asyncHandler } from "../utils/asyncHandler";


export const adminRoutes = Router();

const reasonSchema = z.string().min(10).max(500);
const reviewSchema = z
  .object({
    status: z.enum(['APPROVED', 'REJECTED']),
    notes: z.string().max(500).optional()
  })
  .superRefine((value, ctx) => {
    if (value.status === 'REJECTED') {
      const reason = value.notes?.trim();
      if (!reason || reason.length < 10) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Reason required for rejection (10-500 chars).',
          path: ['notes']
        });
      }
    }
  });

const notesSchema = z.object({
  notes: z.string().max(500).optional()
});

const reasonPayloadSchema = z.object({
  notes: reasonSchema
});

const kycListSchema = z.object({
  status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVISION']).default('PENDING')
});

const kycStatusUpdateSchema = z.object({
  status: z.enum(['APPROVED', 'REJECTED', 'REVISION']),
  comment: z.string().trim().max(2000).optional()
});

const productStatusSchema = z.enum([
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'NEEDS_EDIT',
  'ARCHIVED'
]);

const reviewStatusSchema = z.enum(['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_EDIT']);
const returnStatusSchema = z.object({
  status: z.enum(['CREATED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REFUNDED']),
  adminComment: z.string().max(2000).optional()
});

adminRoutes.use(requireAuth, requireAdmin);

adminRoutes.get('/seller-documents/:id/download', async (req, res, next) => {
  try {
    const document = await prisma.sellerDocument.findUnique({ where: { id: req.params.id } });
    if (!document) {
      return notFound(res, 'Document not found');
    }
    const uploadRoot = path.join(process.cwd(), 'uploads');
    const relativePath = document.url.startsWith('/') ? document.url.slice(1) : document.url;
    const filePath = path.resolve(process.cwd(), relativePath);
    if (!filePath.startsWith(uploadRoot)) {
      return res.status(400).json({ error: { code: 'INVALID_PATH' } });
    }
    if (!fs.existsSync(filePath)) {
      return notFound(res, 'File not found');
    }
    const filename = document.originalName || document.fileName || path.basename(filePath);
    return res.download(filePath, filename);
  } catch (error) {
    return next(error);
  }
});

const kycSubmissionInclude = {
  user: { select: { id: true, name: true, email: true, phone: true } },
  documents: true
} as const;

const listKycSubmissions = async (status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'REVISION') => {
  return prisma.sellerKycSubmission.findMany({
    where: { status },
    include: kycSubmissionInclude,
    orderBy: { createdAt: 'desc' }
  });
};

const reviewSubmission = async (
  id: string,
  status: 'APPROVED' | 'REJECTED' | 'REVISION',
  comment?: string | null,
  reviewerId?: string
) => {
  const submission = await prisma.sellerKycSubmission.findUnique({
    where: { id },
    include: { user: true, documents: true }
  });
  if (!submission) {
    return null;
  }
  const normalizedComment = comment?.trim() ? comment.trim() : null;
  const updated = await prisma.sellerKycSubmission.update({
    where: { id },
    data: {
      status,
      comment: normalizedComment,
      moderationNotes: normalizedComment,
      notes: normalizedComment,
      reviewedAt: new Date(),
      reviewerId: reviewerId ?? null
    },
    include: kycSubmissionInclude
  });
  if (status === 'APPROVED') {
    await prisma.user.update({
      where: { id: updated.userId },
      data: { role: 'SELLER' }
    });
  }
  return updated;
};

adminRoutes.get('/kyc', async (req, res, next) => {
  try {
    const query = kycListSchema.parse(req.query);
    const submissions = await listKycSubmissions(query.status);
    res.json({ data: submissions });
  } catch (error) {
    next(error);
  }
});

adminRoutes.get('/kyc/submissions', async (req, res, next) => {
  try {
    const query = kycListSchema.parse(req.query);
    const submissions = await listKycSubmissions(query.status);
    res.json({ data: submissions });
  } catch (error) {
    next(error);
  }
});

adminRoutes.get('/kyc/:id', async (req, res, next) => {
  try {
    const submission = await prisma.sellerKycSubmission.findUnique({
      where: { id: req.params.id },
      include: kycSubmissionInclude
    });
    if (!submission) {
      return notFound(res, 'KYC submission not found');
    }
    res.json({ data: submission });
  } catch (error) {
    next(error);
  }
});

adminRoutes.patch('/kyc/:id/status', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = kycStatusUpdateSchema.parse(req.body);
    const updated = await reviewSubmission(req.params.id, payload.status, payload.comment ?? null, req.user!.userId);
    if (!updated) {
      return notFound(res, 'KYC submission not found');
    }
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.patch('/kyc/:id', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = reviewSchema.parse(req.body);
    const updated = await reviewSubmission(req.params.id, payload.status, payload.notes ?? null, req.user!.userId);
    if (!updated) {
      return notFound(res, 'KYC submission not found');
    }
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.post('/kyc/:id/approve', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = notesSchema.parse(req.body);
    const updated = await reviewSubmission(req.params.id, 'APPROVED', payload.notes ?? null, req.user!.userId);
    if (!updated) {
      return notFound(res, 'KYC submission not found');
    }
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.post('/kyc/:id/reject', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = reasonPayloadSchema.parse(req.body);
    const updated = await reviewSubmission(req.params.id, 'REJECTED', payload.notes ?? null, req.user!.userId);
    if (!updated) {
      return notFound(res, 'KYC submission not found');
    }
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.get('/products', async (req, res, next) => {
  try {
    const status = productStatusSchema.parse(req.query.status ?? 'PENDING') as ProductModerationStatus;
    const products = await prisma.product.findMany({
      where: { moderationStatus: status },
      include: {
        seller: { select: { id: true, name: true, email: true } },
        images: { orderBy: { sortOrder: 'asc' } }
      },
      orderBy: { updatedAt: 'desc' }
    });
    res.json({ data: products });
  } catch (error) {
    next(error);
  }
});

adminRoutes.post('/products/:id/approve', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const existing = await prisma.product.findUnique({
      where: { id: req.params.id },
      select: { publishedAt: true }
    });
    if (!existing) {
      return notFound(res, 'Product not found');
    }
    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        moderationStatus: 'APPROVED',
        moderationNotes: null,
        moderatedAt: new Date(),
        moderatedById: req.user!.userId,
        publishedAt: existing.publishedAt ?? new Date()
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.patch('/returns/:id/status', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = returnStatusSchema.parse(req.body);
    const updated = await prisma.returnRequest.update({
      where: { id: req.params.id },
      data: {
        status: payload.status,
        adminComment: payload.adminComment?.trim() || null
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.post('/products/:id/reject', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = notesSchema.parse(req.body);
    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        moderationStatus: 'REJECTED',
        moderationNotes: payload.notes ?? null,
        moderatedAt: new Date(),
        moderatedById: req.user!.userId
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.post('/products/:id/needs-edit', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = notesSchema.parse(req.body);
    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        moderationStatus: 'NEEDS_EDIT',
        moderationNotes: payload.notes ?? null,
        moderatedAt: new Date(),
        moderatedById: req.user!.userId
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.delete('/products/:id', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: {
        moderationStatus: 'ARCHIVED',
        moderatedAt: new Date(),
        moderatedById: req.user!.userId
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

const updateProductRating = async (productId: string) => {
  const aggregate = await prisma.review.aggregate({
    where: { productId, moderationStatus: 'APPROVED', isPublic: true },
    _avg: { rating: true },
    _count: { _all: true }
  });
  await prisma.product.update({
    where: { id: productId },
    data: {
      ratingAvg: aggregate._avg.rating ?? 0,
      ratingCount: aggregate._count._all ?? 0
    }
  });
};

adminRoutes.get('/reviews', async (req, res, next) => {
  try {
    const status = reviewStatusSchema.parse(req.query.status ?? 'PENDING') as ReviewModerationStatus;
    const reviews = await prisma.review.findMany({
      where: { moderationStatus: status },
      include: {
        user: { select: { id: true, name: true, email: true } },
        product: { select: { id: true, title: true, image: true } }
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ data: reviews });
  } catch (error) {
    next(error);
  }
});

adminRoutes.post('/reviews/:id/approve', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const updated = await prisma.review.update({
      where: { id: req.params.id },
      data: {
        moderationStatus: 'APPROVED',
        moderationNotes: null,
        moderatedAt: new Date(),
        moderatedById: req.user!.userId,
        status: 'APPROVED'
      }
    });
    await updateProductRating(updated.productId);
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.post('/reviews/:id/reject', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = reasonPayloadSchema.parse(req.body);
    const updated = await prisma.review.update({
      where: { id: req.params.id },
      data: {
        moderationStatus: 'REJECTED',
        moderationNotes: payload.notes ?? null,
        moderatedAt: new Date(),
        moderatedById: req.user!.userId,
        status: 'PENDING'
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});

adminRoutes.post('/reviews/:id/needs-edit', writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = reasonPayloadSchema.parse(req.body);
    const updated = await prisma.review.update({
      where: { id: req.params.id },
      data: {
        moderationStatus: 'NEEDS_EDIT',
        moderationNotes: payload.notes ?? null,
        moderatedAt: new Date(),
        moderatedById: req.user!.userId,
        status: 'PENDING'
      }
    });
    res.json({ data: updated });
  } catch (error) {
    next(error);
  }
});
