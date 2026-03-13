"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiters_1 = require("../middleware/rateLimiters");
const paymentFlowService_1 = require("../services/paymentFlowService");
exports.paymentRoutes = (0, express_1.Router)();
const startSchema = zod_1.z.object({
    paymentAttemptKey: zod_1.z.string().min(6),
    recipient: zod_1.z.object({
        name: zod_1.z.string().trim().min(1),
        phone: zod_1.z.string().trim().min(1),
        email: zod_1.z.string().email().optional().nullable()
    }),
    packagesCount: zod_1.z.number().int().min(1).default(1),
    buyerPickupPvz: zod_1.z.object({
        provider: zod_1.z.string().optional(),
        pvzId: zod_1.z.string().min(1),
        buyerPickupPlatformStationId: zod_1.z.string().regex(/^\d+$/).optional(),
        buyerPickupOperatorStationId: zod_1.z.string().regex(/^\d+$/).optional(),
        addressFull: zod_1.z.string().optional(),
        raw: zod_1.z.unknown().optional()
    }),
    items: zod_1.z
        .array(zod_1.z.object({
        productId: zod_1.z.string(),
        variantId: zod_1.z.string().optional(),
        quantity: zod_1.z.number().int().min(1)
    }))
        .min(1)
});
const webhookSchema = zod_1.z.object({
    paymentId: zod_1.z.string(),
    status: zod_1.z.enum(['success', 'failed', 'cancelled', 'expired']),
    provider: zod_1.z.string().optional()
});
exports.paymentRoutes.post('/start', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = startSchema.parse(req.body);
        const data = await paymentFlowService_1.paymentFlowService.startPayment({
            buyerId: req.user.userId,
            paymentAttemptKey: payload.paymentAttemptKey,
            recipient: payload.recipient,
            packagesCount: payload.packagesCount,
            items: payload.items,
            buyerPickupPvz: {
                ...payload.buyerPickupPvz,
                provider: 'CDEK'
            }
        });
        return res.status(200).json({ data });
    }
    catch (error) {
        return next(error);
    }
});
exports.paymentRoutes.post('/:id/mock-success', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('FORBIDDEN');
        }
        await paymentFlowService_1.paymentFlowService.mockSuccess(req.params.id, req.user.userId);
        return res.json({ data: { ok: true } });
    }
    catch (error) {
        return next(error);
    }
});
exports.paymentRoutes.post('/webhook', async (req, res, next) => {
    try {
        const signature = req.headers['x-signature'];
        if (!signature) {
            return res.status(400).json({ error: { code: 'SIGNATURE_REQUIRED' } });
        }
        const payload = webhookSchema.parse(req.body);
        await paymentFlowService_1.paymentFlowService.processWebhook(payload);
        return res.json({ received: true });
    }
    catch (error) {
        return next(error);
    }
});
