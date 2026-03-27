"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.adminRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const authMiddleware_1 = require("../middleware/authMiddleware");
const prisma_1 = require("../lib/prisma");
const rateLimiters_1 = require("../middleware/rateLimiters");
const httpErrors_1 = require("../utils/httpErrors");
const accessControl_1 = require("../utils/accessControl");
const statusLabels_1 = require("../utils/statusLabels");
exports.adminRoutes = (0, express_1.Router)();
const reasonSchema = zod_1.z.string().min(10).max(500);
const reviewSchema = zod_1.z
    .object({
    status: zod_1.z.enum(['APPROVED', 'REJECTED']),
    notes: zod_1.z.string().max(500).optional()
})
    .superRefine((value, ctx) => {
    if (value.status === 'REJECTED') {
        const reason = value.notes?.trim();
        if (!reason || reason.length < 10) {
            ctx.addIssue({
                code: zod_1.z.ZodIssueCode.custom,
                message: 'Reason required for rejection (10-500 chars).',
                path: ['notes']
            });
        }
    }
});
const notesSchema = zod_1.z.object({
    notes: zod_1.z.string().max(500).optional()
});
const reasonPayloadSchema = zod_1.z.object({
    notes: reasonSchema
});
const kycListSchema = zod_1.z.object({
    status: zod_1.z.enum(['PENDING', 'APPROVED', 'REJECTED', 'REVISION']).default('PENDING')
});
const kycStatusUpdateSchema = zod_1.z.object({
    status: zod_1.z.enum(['APPROVED', 'REJECTED', 'REVISION']),
    comment: zod_1.z.string().trim().max(2000).optional()
});
const productStatusSchema = zod_1.z.enum([
    'DRAFT',
    'PENDING',
    'APPROVED',
    'REJECTED',
    'NEEDS_EDIT',
    'ARCHIVED'
]);
const reviewStatusSchema = zod_1.z.enum(['PENDING', 'APPROVED', 'REJECTED', 'NEEDS_EDIT']);
const returnStatusSchema = zod_1.z.object({
    status: zod_1.z.enum(['CREATED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'REFUNDED']),
    adminComment: zod_1.z.string().max(2000).optional()
});
exports.adminRoutes.use(authMiddleware_1.requireAuth, authMiddleware_1.requireAdmin);
exports.adminRoutes.get('/seller-documents/:id/download', async (req, res, next) => {
    try {
        const document = await prisma_1.prisma.sellerDocument.findUnique({ where: { id: req.params.id } });
        if (!document) {
            return (0, httpErrors_1.notFound)(res, 'Document not found');
        }
        const uploadRoot = path_1.default.join(process.cwd(), 'uploads');
        const relativePath = document.url.startsWith('/') ? document.url.slice(1) : document.url;
        const filePath = path_1.default.resolve(process.cwd(), relativePath);
        if (!filePath.startsWith(uploadRoot)) {
            return res.status(400).json({ error: { code: 'INVALID_PATH' } });
        }
        if (!fs_1.default.existsSync(filePath)) {
            return (0, httpErrors_1.notFound)(res, 'File not found');
        }
        const filename = document.originalName || document.fileName || path_1.default.basename(filePath);
        return res.download(filePath, filename);
    }
    catch (error) {
        return next(error);
    }
});
const kycSubmissionInclude = {
    user: { select: { id: true, name: true, email: true, phone: true, role: true } },
    documents: true
};
const mapKycSubmission = (submission) => ({
    ...submission,
    statusLabelRu: (0, statusLabels_1.getKycStatusLabelRu)(submission.status)
});
const mapReviewModeration = (review) => ({
    ...review,
    moderationStatusLabelRu: (0, statusLabels_1.getReviewModerationStatusLabelRu)(review.moderationStatus)
});
const listKycSubmissions = async (status) => {
    return prisma_1.prisma.sellerKycSubmission.findMany({
        where: { status },
        include: kycSubmissionInclude,
        orderBy: { createdAt: 'desc' }
    });
};
const reviewSubmission = async (id, status, comment, reviewerId) => {
    const submission = await prisma_1.prisma.sellerKycSubmission.findUnique({
        where: { id },
        include: { user: true, documents: true }
    });
    if (!submission) {
        return null;
    }
    const normalizedComment = comment?.trim() ? comment.trim() : null;
    const updated = await prisma_1.prisma.sellerKycSubmission.update({
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
        await prisma_1.prisma.user.update({
            where: { id: updated.userId },
            data: { role: (0, accessControl_1.resolveRoleAfterSellerEnablement)(updated.user.role) }
        });
    }
    return updated;
};
exports.adminRoutes.get('/kyc', async (req, res, next) => {
    try {
        const query = kycListSchema.parse(req.query);
        const submissions = await listKycSubmissions(query.status);
        res.json({ data: submissions.map(mapKycSubmission) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.get('/kyc/submissions', async (req, res, next) => {
    try {
        const query = kycListSchema.parse(req.query);
        const submissions = await listKycSubmissions(query.status);
        res.json({ data: submissions.map(mapKycSubmission) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.get('/kyc/:id', async (req, res, next) => {
    try {
        const submission = await prisma_1.prisma.sellerKycSubmission.findUnique({
            where: { id: req.params.id },
            include: kycSubmissionInclude
        });
        if (!submission) {
            return (0, httpErrors_1.notFound)(res, 'KYC submission not found');
        }
        res.json({ data: mapKycSubmission(submission) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.patch('/kyc/:id/status', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = kycStatusUpdateSchema.parse(req.body);
        const updated = await reviewSubmission(req.params.id, payload.status, payload.comment ?? null, req.user.userId);
        if (!updated) {
            return (0, httpErrors_1.notFound)(res, 'KYC submission not found');
        }
        res.json({ data: mapKycSubmission(updated) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.patch('/kyc/:id', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = reviewSchema.parse(req.body);
        const updated = await reviewSubmission(req.params.id, payload.status, payload.notes ?? null, req.user.userId);
        if (!updated) {
            return (0, httpErrors_1.notFound)(res, 'KYC submission not found');
        }
        res.json({ data: mapKycSubmission(updated) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.post('/kyc/:id/approve', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = notesSchema.parse(req.body);
        const updated = await reviewSubmission(req.params.id, 'APPROVED', payload.notes ?? null, req.user.userId);
        if (!updated) {
            return (0, httpErrors_1.notFound)(res, 'KYC submission not found');
        }
        res.json({ data: mapKycSubmission(updated) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.post('/kyc/:id/reject', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = reasonPayloadSchema.parse(req.body);
        const updated = await reviewSubmission(req.params.id, 'REJECTED', payload.notes ?? null, req.user.userId);
        if (!updated) {
            return (0, httpErrors_1.notFound)(res, 'KYC submission not found');
        }
        res.json({ data: mapKycSubmission(updated) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.get('/products', async (req, res, next) => {
    try {
        const status = productStatusSchema.parse(req.query.status ?? 'PENDING');
        const products = await prisma_1.prisma.product.findMany({
            where: { moderationStatus: status, deletedAt: null },
            include: {
                seller: { select: { id: true, name: true, email: true } },
                images: { orderBy: { sortOrder: 'asc' } }
            },
            orderBy: { updatedAt: 'desc' }
        });
        res.json({ data: products });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.delete('/products/:productId', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const product = await prisma_1.prisma.product.findUnique({ where: { id: req.params.productId }, select: { id: true } });
        if (!product) {
            return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND', message: 'Товар не найден.' } });
        }
        await prisma_1.prisma.product.updateMany({
            where: { OR: [{ id: req.params.productId }, { parentProductId: req.params.productId }] },
            data: { deletedAt: new Date(), moderationStatus: 'ARCHIVED' }
        });
        return res.json({ ok: true, data: { id: req.params.productId, deleted: true } });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.post('/products/:id/approve', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const existing = await prisma_1.prisma.product.findUnique({
            where: { id: req.params.id },
            select: { publishedAt: true }
        });
        if (!existing) {
            return (0, httpErrors_1.notFound)(res, 'Product not found');
        }
        const updated = await prisma_1.prisma.product.update({
            where: { id: req.params.id },
            data: {
                moderationStatus: 'APPROVED',
                moderationNotes: null,
                moderatedAt: new Date(),
                moderatedById: req.user.userId,
                publishedAt: existing.publishedAt ?? new Date()
            }
        });
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.patch('/returns/:id/status', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = returnStatusSchema.parse(req.body);
        const updated = await prisma_1.prisma.returnRequest.update({
            where: { id: req.params.id },
            data: {
                status: payload.status,
                adminComment: payload.adminComment?.trim() || null
            }
        });
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.post('/products/:id/reject', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = notesSchema.parse(req.body);
        const updated = await prisma_1.prisma.product.update({
            where: { id: req.params.id },
            data: {
                moderationStatus: 'REJECTED',
                moderationNotes: payload.notes ?? null,
                moderatedAt: new Date(),
                moderatedById: req.user.userId
            }
        });
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.post('/products/:id/needs-edit', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = notesSchema.parse(req.body);
        const updated = await prisma_1.prisma.product.update({
            where: { id: req.params.id },
            data: {
                moderationStatus: 'NEEDS_EDIT',
                moderationNotes: payload.notes ?? null,
                moderatedAt: new Date(),
                moderatedById: req.user.userId
            }
        });
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.delete('/products/:id', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const updated = await prisma_1.prisma.product.update({
            where: { id: req.params.id },
            data: {
                moderationStatus: 'ARCHIVED',
                moderatedAt: new Date(),
                moderatedById: req.user.userId
            }
        });
        res.json({ data: updated });
    }
    catch (error) {
        next(error);
    }
});
const updateProductRating = async (productId) => {
    const aggregate = await prisma_1.prisma.review.aggregate({
        where: { productId, moderationStatus: 'APPROVED', isPublic: true },
        _avg: { rating: true },
        _count: { _all: true }
    });
    await prisma_1.prisma.product.update({
        where: { id: productId },
        data: {
            ratingAvg: aggregate._avg.rating ?? 0,
            ratingCount: aggregate._count._all ?? 0
        }
    });
};
exports.adminRoutes.get('/reviews', async (req, res, next) => {
    try {
        const status = reviewStatusSchema.parse(req.query.status ?? 'PENDING');
        const reviews = await prisma_1.prisma.review.findMany({
            where: { moderationStatus: status },
            include: {
                user: { select: { id: true, name: true, email: true } },
                product: { select: { id: true, title: true, image: true } }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json({ data: reviews.map(mapReviewModeration) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.post('/reviews/:id/approve', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const updated = await prisma_1.prisma.review.update({
            where: { id: req.params.id },
            data: {
                moderationStatus: 'APPROVED',
                moderationNotes: null,
                moderatedAt: new Date(),
                moderatedById: req.user.userId,
                status: 'APPROVED'
            }
        });
        await updateProductRating(updated.productId);
        res.json({ data: mapReviewModeration(updated) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.post('/reviews/:id/reject', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = reasonPayloadSchema.parse(req.body);
        const updated = await prisma_1.prisma.review.update({
            where: { id: req.params.id },
            data: {
                moderationStatus: 'REJECTED',
                moderationNotes: payload.notes ?? null,
                moderatedAt: new Date(),
                moderatedById: req.user.userId,
                status: 'PENDING'
            }
        });
        res.json({ data: mapReviewModeration(updated) });
    }
    catch (error) {
        next(error);
    }
});
exports.adminRoutes.post('/reviews/:id/needs-edit', rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = reasonPayloadSchema.parse(req.body);
        const updated = await prisma_1.prisma.review.update({
            where: { id: req.params.id },
            data: {
                moderationStatus: 'NEEDS_EDIT',
                moderationNotes: payload.notes ?? null,
                moderatedAt: new Date(),
                moderatedById: req.user.userId,
                status: 'PENDING'
            }
        });
        res.json({ data: mapReviewModeration(updated) });
    }
    catch (error) {
        next(error);
    }
});
