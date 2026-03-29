"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.paymentRoutes = void 0;
const express_1 = require("express");
const client_1 = require("@prisma/client");
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
const yookassaWebhookSchema = zod_1.z.object({
    event: zod_1.z.enum(['payment.succeeded', 'payment.canceled']),
    object: zod_1.z.object({
        id: zod_1.z.string(),
        status: zod_1.z.string().optional()
    })
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
        const message = error instanceof Error ? error.message : '';
        const mappedStatus = message === 'PRODUCT_NOT_FOUND' ||
            message === 'MULTI_SELLER_CHECKOUT_NOT_SUPPORTED' ||
            message === 'SELLER_DROPOFF_PVZ_REQUIRED'
            ? 400
            : message === 'ORDER_CREATE_FAILED' || message === 'YOOKASSA_CONFIG_MISSING'
                ? 500
                : message === 'YOOKASSA_CREATE_FAILED'
                    ? 502
                    : null;
        if (mappedStatus) {
            return res.status(mappedStatus).json({
                error: {
                    code: message,
                    message
                }
            });
        }
        console.error('[PAYMENT][ERROR]', {
            route: 'POST /payments/start',
            buyerId: req.user?.userId,
            error,
            message,
            stack: error instanceof Error ? error.stack : undefined,
            prismaCode: error instanceof client_1.Prisma.PrismaClientKnownRequestError ? error.code : undefined,
            prismaMeta: error instanceof client_1.Prisma.PrismaClientKnownRequestError ? error.meta : undefined
        });
        return next(error);
    }
});
exports.paymentRoutes.post('/yookassa/webhook', async (req, res, next) => {
    try {
        const payload = yookassaWebhookSchema.parse(req.body);
        const mappedStatus = payload.event === 'payment.succeeded' ? 'success' : 'cancelled';
        console.info('[YOOKASSA][webhook]', {
            event: payload.event,
            paymentId: payload.object.id,
            status: payload.object.status ?? null
        });
        await paymentFlowService_1.paymentFlowService.processWebhook({
            externalId: payload.object.id,
            status: mappedStatus,
            provider: 'yookassa',
            payload
        });
        return res.json({ received: true });
    }
    catch (error) {
        return next(error);
    }
});
