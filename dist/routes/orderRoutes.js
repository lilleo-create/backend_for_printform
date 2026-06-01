"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiters_1 = require("../middleware/rateLimiters");
const prisma_1 = require("../lib/prisma");
const orderUseCases_1 = require("../usecases/orderUseCases");
const orderPayment_1 = require("../utils/orderPayment");
const paymentFlowService_1 = require("../services/paymentFlowService");
const orderPublicId_1 = require("../utils/orderPublicId");
const cdekService_1 = require("../services/cdekService");
const deliveryLabels_1 = require("../utils/deliveryLabels");
// Extracts city_code from CDEK PVZ metadata regardless of nesting depth
const extractCityCode = (meta) => {
    const rec = (v) => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
    const m = rec(meta);
    const r = rec(m.raw);
    const rr = rec(r.raw);
    const loc = rec(r.location);
    const rrloc = rec(rr.location);
    return (num(m.cityCode) ||
        num(m.city_code) ||
        num(r.cityCode) ||
        num(r.city_code) ||
        num(loc.city_code) ||
        num(rr.city_code) ||
        num(rrloc.city_code) ||
        0);
};
const serializers_1 = require("../utils/serializers");
exports.orderRoutes = (0, express_1.Router)();
const buyerPvzSelectionSchema = zod_1.z.object({
    provider: zod_1.z.string().optional(),
    pvzId: zod_1.z.string().min(1),
    addressFull: zod_1.z.string().optional(),
    country: zod_1.z.string().optional(),
    locality: zod_1.z.string().optional(),
    street: zod_1.z.string().optional(),
    house: zod_1.z.string().optional(),
    comment: zod_1.z.string().optional(),
    raw: zod_1.z.unknown()
});
const cdekPvzRawSchema = zod_1.z.object({
    city_code: zod_1.z.number().int().positive(),
    city: zod_1.z.string().optional(),
    address_full: zod_1.z.string().optional(),
    latitude: zod_1.z.number().optional(),
    longitude: zod_1.z.number().optional(),
    work_time: zod_1.z.string().optional()
});
const createOrderSchema = zod_1.z.object({
    buyerPickupPvz: buyerPvzSelectionSchema.optional(),
    cdekPvzCode: zod_1.z.string().min(1).optional(),
    cdekPvzAddress: zod_1.z.string().optional(),
    cdekPvzCityCode: zod_1.z.number().int().positive().optional(),
    cdekPvzRaw: cdekPvzRawSchema.optional(),
    deliveryMethod: zod_1.z.enum(['courier', 'cdek_pvz']).optional(),
    contactId: zod_1.z.string().optional(),
    shippingAddressId: zod_1.z.string().optional(),
    items: zod_1.z
        .array(zod_1.z.object({
        productId: zod_1.z.string(),
        variantId: zod_1.z.string().optional(),
        quantity: zod_1.z.number().int().min(1)
    }))
        .min(1)
});
exports.orderRoutes.post('/', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        await (0, orderPayment_1.expirePendingPayments)();
        const payload = createOrderSchema.parse(req.body);
        const { cdekPvzCode, cdekPvzAddress, deliveryMethod, cdekPvzRaw, cdekPvzCityCode } = payload;
        if (deliveryMethod === 'cdek_pvz' && !cdekPvzCode) {
            return res.status(400).json({ error: { code: 'CDEK_PVZ_CODE_REQUIRED', message: 'cdekPvzCode is required for cdek_pvz', details: null } });
        }
        const resolvedBuyerCityCode = Number(cdekPvzCityCode ?? cdekPvzRaw?.city_code ?? 0);
        if (deliveryMethod === 'cdek_pvz' && (!Number.isFinite(resolvedBuyerCityCode) || resolvedBuyerCityCode <= 0)) {
            return res.status(400).json({ error: { code: 'CITY_CODE_MISSING', message: 'cdekPvzCityCode or cdekPvzRaw.city_code is required', details: null } });
        }
        const productIds = payload.items.map((item) => item.productId);
        const uniqueProductIds = Array.from(new Set(productIds));
        const products = await prisma_1.prisma.product.findMany({
            where: { id: { in: uniqueProductIds }, deletedAt: null, moderationStatus: 'APPROVED' },
            select: { id: true, sellerId: true }
        });
        if (products.length !== uniqueProductIds.length) {
            return res.status(404).json({ error: { code: 'PRODUCT_NOT_FOUND' } });
        }
        const sellerIds = Array.from(new Set(products.map((product) => product.sellerId)));
        if (sellerIds.length !== 1) {
            return res.status(400).json({ error: { code: 'MULTI_SELLER_CHECKOUT_NOT_SUPPORTED' } });
        }
        const sellerSettings = await prisma_1.prisma.sellerSettings.findUnique({ where: { sellerId: sellerIds[0] } });
        if (sellerSettings?.defaultDropoffPvzId) {
            const cityCode = extractCityCode(sellerSettings.defaultDropoffPvzMeta);
            if (cityCode <= 0) {
                return res.status(400).json({
                    error: {
                        code: 'CITY_CODE_MISSING',
                        message: 'seller CDEK dropoff PVZ meta must contain city_code',
                        details: { sellerId: sellerIds[0] }
                    }
                });
            }
        }
        const sellerDropoffMeta = sellerSettings?.defaultDropoffPvzMeta;
        const sellerDropoffRaw = sellerDropoffMeta && typeof sellerDropoffMeta === 'object'
            ? (sellerDropoffMeta.raw ?? {})
            : {};
        const sellerDropoffAddress = sellerDropoffMeta && typeof sellerDropoffMeta === 'object'
            ? String(sellerDropoffMeta.addressFull ?? '')
            : undefined;
        // Calculate delivery cost before creating the order so seller sees it immediately
        let deliveryAmountKopecks = 0;
        let deliveryDaysMin;
        let deliveryDaysMax;
        const sellerCityCode = extractCityCode(sellerDropoffMeta);
        const buyerCityCode = resolvedBuyerCityCode > 0
            ? resolvedBuyerCityCode
            : extractCityCode(payload.buyerPickupPvz);
        if (sellerCityCode > 0 && buyerCityCode > 0) {
            try {
                const quote = await cdekService_1.cdekService.calculateDelivery({
                    fromCityCode: sellerCityCode,
                    toCityCode: buyerCityCode,
                    weightGrams: 500
                });
                deliveryAmountKopecks = Math.round(quote.totalSum * 100);
                deliveryDaysMin = quote.deliveryDaysMin || undefined;
                deliveryDaysMax = quote.deliveryDaysMax || undefined;
            }
            catch (calcErr) {
                console.warn('[ORDER][delivery-cost-calc-failed]', { sellerCityCode, buyerCityCode: resolvedBuyerCityCode, calcErr });
            }
        }
        const order = await orderUseCases_1.orderUseCases.create({
            buyerId: req.user.userId,
            contactId: payload.contactId,
            shippingAddressId: payload.shippingAddressId,
            items: payload.items,
            buyerPickupPvz: cdekPvzCode
                ? {
                    provider: 'CDEK',
                    pvzId: cdekPvzCode,
                    raw: {
                        city_code: resolvedBuyerCityCode,
                        city: cdekPvzRaw?.city ?? '',
                        address_full: cdekPvzRaw?.address_full ?? cdekPvzAddress ?? '',
                        latitude: cdekPvzRaw?.latitude,
                        longitude: cdekPvzRaw?.longitude,
                        work_time: cdekPvzRaw?.work_time
                    },
                    addressFull: cdekPvzAddress ?? cdekPvzRaw?.address_full ?? ''
                }
                : payload.buyerPickupPvz
                    ? {
                        provider: 'CDEK',
                        pvzId: payload.buyerPickupPvz.pvzId,
                        addressFull: payload.buyerPickupPvz.addressFull,
                        raw: payload.buyerPickupPvz.raw ?? {}
                    }
                    : deliveryMethod === 'courier'
                        ? undefined
                        : undefined,
            sellerDropoffPvz: sellerSettings?.defaultDropoffPvzId
                ? {
                    provider: 'CDEK',
                    pvzId: sellerSettings.defaultDropoffPvzId,
                    raw: sellerDropoffRaw,
                    addressFull: sellerDropoffAddress
                }
                : undefined,
            deliveryAmountKopecks,
            deliveryDaysMin,
            deliveryDaysMax
        });
        return res.status(201).json({ data: (0, orderPublicId_1.withOrderPublicId)(order), orderId: order.id });
    }
    catch (error) {
        return next(error);
    }
});
exports.orderRoutes.post('/:id/pay', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const order = await prisma_1.prisma.order.findFirst({ where: { id: req.params.id, buyerId: req.user.userId } });
        if (!order) {
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
        }
        return res.status(409).json({ error: { code: 'PAYMENT_FLOW_CHANGED', message: 'Use POST /payments/start for payment flow' } });
    }
    catch (error) {
        return next(error);
    }
});
exports.orderRoutes.post('/:orderId/retry-payment', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const retried = await paymentFlowService_1.paymentFlowService.retryPayment(req.params.orderId, req.user.userId);
        return res.json({ ok: true, data: retried });
    }
    catch (error) {
        return next(error);
    }
});
exports.orderRoutes.post('/:id/ready-for-shipment', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const order = await prisma_1.prisma.order.findFirst({
            where: {
                id: req.params.id,
                status: 'PAID',
                items: { some: { product: { sellerId: req.user.userId } } }
            }
        });
        if (!order) {
            return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
        }
        const now = new Date();
        const updated = await prisma_1.prisma.order.update({
            where: { id: order.id },
            data: {
                status: 'READY_FOR_SHIPMENT',
                readyForShipmentAt: now,
                dropoffDeadlineAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
            }
        });
        return res.json({ data: (0, orderPublicId_1.withOrderPublicId)(updated) });
    }
    catch (error) {
        return next(error);
    }
});
exports.orderRoutes.post('/:orderId/cancel', authMiddleware_1.authenticate, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const { order, refund } = await paymentFlowService_1.paymentFlowService.createOrderCancellationRefund({
            orderId: req.params.orderId,
            buyerId: req.user.userId
        });
        return res.json({ data: (0, orderPublicId_1.withOrderPublicId)(order), refund });
    }
    catch (error) {
        const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
        if (message === 'ORDER_NOT_FOUND') {
            return res.status(404).json({ error: { code: message } });
        }
        if (message === 'ORDER_NOT_PAID' ||
            message === 'ORDER_ALREADY_SHIPPED' ||
            message === 'REFUND_AMOUNT_EXCEEDS_PAYMENT' ||
            message === 'PAYMENT_EXTERNAL_ID_NOT_FOUND') {
            return res.status(409).json({ error: { code: message } });
        }
        if (message === 'REFUND_CREATE_FAILED') {
            return res.status(502).json({ error: { code: message } });
        }
        return next(error);
    }
});
exports.orderRoutes.get('/me', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        await (0, orderPayment_1.expirePendingPayments)();
        const orders = await prisma_1.prisma.order.findMany({
            where: { buyerId: req.user.userId },
            include: { items: { include: { product: true, variant: true } }, shipment: true, deliveryEvents: { orderBy: { createdAt: 'desc' } } },
            orderBy: { createdAt: 'desc' }
        });
        res.json({
            data: orders.map((order) => {
                const timing = (0, orderPayment_1.computePaymentTiming)(order);
                const base = (0, serializers_1.stripInternalOrderFields)((0, orderPublicId_1.withOrderPublicId)(order));
                return {
                    ...base,
                    ...timing,
                    canRetryPayment: (0, orderPayment_1.canRetryPayment)(order),
                    retryPaymentAvailable: (0, orderPayment_1.canRetryPayment)(order),
                    financials: (0, serializers_1.financialsForBuyer)(order),
                    deliveryStatusLabel: (0, deliveryLabels_1.resolveDeliveryStatusLabel)(order),
                    deliveryEta: order.deliveryDaysMin && order.deliveryDaysMax
                        ? { daysMin: order.deliveryDaysMin, daysMax: order.deliveryDaysMax, text: order.deliveryEtaText ?? null }
                        : null
                };
            })
        });
    }
    catch (error) {
        next(error);
    }
});
exports.orderRoutes.get('/:id/delivery/history', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const order = await prisma_1.prisma.order.findFirst({
            where: {
                id: req.params.id,
                OR: [{ buyerId: req.user.userId }, { items: { some: { product: { sellerId: req.user.userId } } } }]
            },
            include: { deliveryEvents: { orderBy: { createdAt: 'desc' } } }
        });
        if (!order) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        return res.json({ data: order.deliveryEvents });
    }
    catch (error) {
        return next(error);
    }
});
exports.orderRoutes.get('/:id', authMiddleware_1.authenticate, async (req, res, next) => {
    try {
        const userId = req.user.userId;
        const order = await prisma_1.prisma.order.findFirst({
            where: {
                id: req.params.id,
                OR: [{ buyerId: userId }, { items: { some: { product: { sellerId: userId } } } }]
            },
            include: {
                items: { include: { product: true, variant: true } },
                contact: true,
                shippingAddress: true,
                buyer: { select: serializers_1.BUYER_PUBLIC_SELECT },
                deliveryEvents: { orderBy: { createdAt: 'desc' } }
            }
        });
        if (!order) {
            return res.status(404).json({ error: { code: 'NOT_FOUND' } });
        }
        const isSeller = order.items.some((item) => item.product.sellerId === userId);
        const base = (0, orderPublicId_1.withOrderPublicId)(order);
        const deliveryStatusLabel = (0, deliveryLabels_1.resolveDeliveryStatusLabel)(order);
        const deliveryEta = order.deliveryDaysMin && order.deliveryDaysMax
            ? { daysMin: order.deliveryDaysMin, daysMax: order.deliveryDaysMax, text: order.deliveryEtaText ?? null }
            : null;
        if (isSeller) {
            return res.json({
                data: { ...base, financials: (0, serializers_1.financialsForSeller)(order), deliveryStatusLabel, deliveryEta }
            });
        }
        return res.json({
            data: {
                ...(0, serializers_1.stripInternalOrderFields)(base),
                financials: (0, serializers_1.financialsForBuyer)(order),
                deliveryStatusLabel,
                deliveryEta
            }
        });
    }
    catch (error) {
        return next(error);
    }
});
