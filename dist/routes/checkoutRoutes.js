"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkoutRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiters_1 = require("../middleware/rateLimiters");
const prisma_1 = require("../lib/prisma");
exports.checkoutRoutes = (0, express_1.Router)();
const recipientSchema = zod_1.z.object({
    name: zod_1.z.string().min(2),
    phone: zod_1.z.string().min(5),
    email: zod_1.z.string().email()
});
const addressSchema = zod_1.z.object({
    line1: zod_1.z.string().min(3),
    city: zod_1.z.string().min(2),
    postalCode: zod_1.z.string().min(2),
    country: zod_1.z.string().min(2),
    apartment: zod_1.z.string().optional(),
    floor: zod_1.z.string().optional(),
    comment: zod_1.z.string().optional()
});
const pickupPointSchema = zod_1.z.object({
    // PVZ id from widget (uuid)
    id: zod_1.z.string().min(1),
    buyerPickupPointId: zod_1.z.string().optional(),
    // ✅ platform_id for request/create is UUID (PVZ id), not digits.
    buyerPickupPlatformStationId: zod_1.z.string().nullable().optional(),
    // digits operator station id (useful for offers/* расчёты)
    buyerPickupOperatorStationId: zod_1.z.string().regex(/^\d+$/).nullable().optional(),
    operator_station_id: zod_1.z.string().regex(/^\d+$/).nullable().optional(),
    fullAddress: zod_1.z.string().min(1),
    country: zod_1.z.string().optional(),
    locality: zod_1.z.string().optional(),
    street: zod_1.z.string().optional(),
    house: zod_1.z.string().optional(),
    comment: zod_1.z.string().optional(),
    position: zod_1.z
        .object({
        lat: zod_1.z.number().optional(),
        lng: zod_1.z.number().optional()
    })
        .passthrough()
        .optional(),
    type: zod_1.z.string().optional(),
    paymentMethods: zod_1.z.array(zod_1.z.string()).optional()
});
const pickupSchema = zod_1.z.object({
    pickupPoint: pickupPointSchema,
    provider: zod_1.z.string().min(1)
});
const deliveryMethodSchema = zod_1.z.object({
    methodCode: zod_1.z.enum(['ADDRESS', 'PICKUP', 'COURIER', 'PICKUP_POINT']),
    subType: zod_1.z.string().optional()
});
const paymentMethodSchema = zod_1.z.object({
    methodCode: zod_1.z.enum(['CARD', 'SBP']),
    cardId: zod_1.z.string().optional()
});
const cardSchema = zod_1.z.object({
    cardNumber: zod_1.z.string().min(12),
    expMonth: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]),
    expYear: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]),
    cvv: zod_1.z.string().min(3).max(4)
});
const DELIVERY_METHODS = [
    { id: 'courier', code: 'COURIER', title: 'Курьером', description: 'Курьером до двери' },
    { id: 'pickup_point', code: 'PICKUP_POINT', title: 'Самовывоз', description: 'Пункт выдачи или постамат' }
];
const PAYMENT_METHODS = [
    { id: 'card', code: 'CARD', title: 'Банковской картой' },
    { id: 'sbp', code: 'SBP', title: 'СБП' }
];
let setupPromise = null;
const ensureCheckoutTables = async () => {
    if (!setupPromise) {
        setupPromise = (async () => {
            await prisma_1.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_checkout_preferences (
          user_id TEXT PRIMARY KEY,
          delivery_method TEXT NOT NULL DEFAULT 'COURIER',
          delivery_sub_type TEXT,
          delivery_provider TEXT,
          payment_method TEXT NOT NULL DEFAULT 'CARD',
          selected_card_id TEXT,
          pickup_point_id TEXT,
          pickup_provider TEXT,
          pickup_point_json JSONB,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
            await prisma_1.prisma.$executeRawUnsafe(`
        ALTER TABLE user_checkout_preferences
          ADD COLUMN IF NOT EXISTS delivery_provider TEXT,
          ADD COLUMN IF NOT EXISTS pickup_point_json JSONB
      `);
            await prisma_1.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS user_saved_cards (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          brand TEXT NOT NULL,
          last4 TEXT NOT NULL,
          exp_month INT NOT NULL,
          exp_year INT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
        })().then(() => undefined);
    }
    return setupPromise;
};
const normalizeDeliveryMethod = (method) => {
    if (method === 'ADDRESS')
        return 'COURIER';
    if (method === 'PICKUP')
        return 'PICKUP_POINT';
    return method ?? 'COURIER';
};
const getBrand = (cardNumber) => {
    if (cardNumber.startsWith('4'))
        return 'VISA';
    if (cardNumber.startsWith('5'))
        return 'Mastercard';
    if (cardNumber.startsWith('2'))
        return 'МИР';
    return 'CARD';
};
const getCheckoutData = async (userId) => {
    await ensureCheckoutTables();
    const user = await prisma_1.prisma.user.findUnique({ where: { id: userId } });
    const contact = await prisma_1.prisma.contact.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
    const defaultAddress = await prisma_1.prisma.address.findFirst({ where: { userId, isDefault: true } });
    const prefsRows = await prisma_1.prisma.$queryRawUnsafe('SELECT * FROM user_checkout_preferences WHERE user_id = $1 LIMIT 1', userId);
    const prefs = prefsRows[0];
    const cards = await prisma_1.prisma.$queryRawUnsafe(`SELECT id, brand, last4, exp_month, exp_year
     FROM user_saved_cards
     WHERE user_id = $1
     ORDER BY created_at DESC`, userId);
    const products = await prisma_1.prisma.product.findMany({
        take: 4,
        orderBy: { createdAt: 'desc' },
        select: {
            id: true,
            title: true,
            price: true,
            image: true,
            descriptionShort: true,
            sku: true,
            sellerId: true,
            weightGrossG: true,
            dxCm: true,
            dyCm: true,
            dzCm: true
        }
    });
    const parsedPickupPoint = pickupPointSchema.safeParse(prefs?.pickup_point_json);
    const cartItems = products.map((item) => {
        // Срок доставки CDEK рассчитывается через /api/cdek/calculate-for-order после оформления
        const deliveryDays = null;
        const etaMinDays = null;
        const etaMaxDays = null;
        return {
            productId: item.id,
            title: item.title,
            price: item.price,
            quantity: 1,
            image: item.image,
            shortSpec: item.descriptionShort || item.sku,
            productionTimeHours: 24,
            deliveryDays,
            etaMinDays,
            etaMaxDays,
            dimensions: item.dxCm && item.dyCm && item.dzCm ? { dxCm: item.dxCm, dyCm: item.dyCm, dzCm: item.dzCm } : null,
            weightGrossG: item.weightGrossG ?? null
        };
    });
    return {
        recipient: {
            name: contact?.name ?? user?.fullName ?? user?.name ?? '',
            phone: contact?.phone ?? user?.phone ?? '',
            email: contact?.email ?? user?.email ?? ''
        },
        address: defaultAddress
            ? {
                line1: defaultAddress.addressText,
                city: 'Москва',
                postalCode: '125040',
                country: 'Россия',
                apartment: defaultAddress.apartment ?? null,
                floor: defaultAddress.floor ?? null,
                comment: defaultAddress.courierComment ?? null
            }
            : null,
        selectedPickupPoint: parsedPickupPoint.success ? parsedPickupPoint.data : null,
        selectedDeliveryMethod: normalizeDeliveryMethod(prefs?.delivery_method),
        selectedDeliverySubType: prefs?.delivery_sub_type ?? null,
        selectedPaymentMethod: prefs?.payment_method ?? 'CARD',
        selectedCardId: prefs?.selected_card_id ?? null,
        deliveryMethods: DELIVERY_METHODS,
        paymentMethods: PAYMENT_METHODS,
        savedCards: cards.map((card) => ({
            id: card.id,
            brand: card.brand,
            last4: card.last4,
            expMonth: card.exp_month,
            expYear: card.exp_year
        })),
        cartItems
    };
};
exports.checkoutRoutes.get('/', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        const data = await getCheckoutData(req.user.userId);
        res.json(data);
    }
    catch (error) {
        next(error);
    }
});
exports.checkoutRoutes.put('/recipient', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = recipientSchema.parse(req.body);
        const existing = await prisma_1.prisma.contact.findFirst({
            where: { userId: req.user.userId },
            orderBy: { createdAt: 'desc' }
        });
        if (existing) {
            await prisma_1.prisma.contact.update({
                where: { id: existing.id },
                data: { name: payload.name, phone: payload.phone, email: payload.email }
            });
        }
        else {
            await prisma_1.prisma.contact.create({
                data: { userId: req.user.userId, name: payload.name, phone: payload.phone, email: payload.email }
            });
        }
        res.json({ ok: true });
    }
    catch (error) {
        next(error);
    }
});
exports.checkoutRoutes.put('/address', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = addressSchema.parse(req.body);
        const existing = await prisma_1.prisma.address.findFirst({ where: { userId: req.user.userId, isDefault: true } });
        if (existing) {
            await prisma_1.prisma.address.update({
                where: { id: existing.id },
                data: {
                    addressText: payload.line1,
                    apartment: payload.apartment,
                    floor: payload.floor,
                    courierComment: payload.comment
                }
            });
        }
        else {
            await prisma_1.prisma.address.create({
                data: {
                    userId: req.user.userId,
                    addressText: payload.line1,
                    apartment: payload.apartment,
                    floor: payload.floor,
                    courierComment: payload.comment,
                    isDefault: true
                }
            });
        }
        res.json({ ok: true });
    }
    catch (error) {
        next(error);
    }
});
exports.checkoutRoutes.put('/pickup', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = pickupSchema.parse(req.body);
        const buyerPickupPvzId = payload.pickupPoint.id.trim();
        if (!buyerPickupPvzId) {
            return res.status(400).json({
                error: { code: 'VALIDATION_ERROR', message: 'pickupPoint.id обязателен.' }
            });
        }
        const pickupPointJson = {
            ...payload.pickupPoint,
            id: buyerPickupPvzId,
            buyerPickupPvzId,
            addressFull: payload.pickupPoint.fullAddress
        };
        console.info('[CHECKOUT][buyer_pvz_saved]', {
            buyerId: req.user.userId,
            provider: payload.provider,
            buyerPickupPvzId,
            addressFull: payload.pickupPoint.fullAddress
        });
        await ensureCheckoutTables();
        await prisma_1.prisma.$executeRawUnsafe(`
        INSERT INTO user_checkout_preferences (user_id, pickup_point_id, pickup_provider, pickup_point_json, delivery_provider, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $3, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET pickup_point_id = EXCLUDED.pickup_point_id,
          pickup_provider = EXCLUDED.pickup_provider,
          pickup_point_json = EXCLUDED.pickup_point_json,
          delivery_provider = EXCLUDED.delivery_provider,
          delivery_method = 'PICKUP_POINT',
          updated_at = NOW()
      `, req.user.userId, buyerPickupPvzId, payload.provider, JSON.stringify(pickupPointJson));
        res.json({ ok: true });
    }
    catch (error) {
        next(error);
    }
});
exports.checkoutRoutes.put('/delivery-method', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = deliveryMethodSchema.parse(req.body);
        const normalizedMethod = normalizeDeliveryMethod(payload.methodCode);
        await ensureCheckoutTables();
        await prisma_1.prisma.$executeRawUnsafe(`
        INSERT INTO user_checkout_preferences (user_id, delivery_method, delivery_sub_type, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET delivery_method = EXCLUDED.delivery_method,
          delivery_sub_type = EXCLUDED.delivery_sub_type,
          pickup_point_id = CASE WHEN EXCLUDED.delivery_method = 'COURIER' THEN NULL ELSE user_checkout_preferences.pickup_point_id END,
          pickup_provider = CASE WHEN EXCLUDED.delivery_method = 'COURIER' THEN NULL ELSE user_checkout_preferences.pickup_provider END,
          pickup_point_json = CASE WHEN EXCLUDED.delivery_method = 'COURIER' THEN NULL ELSE user_checkout_preferences.pickup_point_json END,
          updated_at = NOW()
      `, req.user.userId, normalizedMethod, payload.subType ?? null);
        res.json({ ok: true });
    }
    catch (error) {
        next(error);
    }
});
exports.checkoutRoutes.put('/payment-method', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = paymentMethodSchema.parse(req.body);
        await ensureCheckoutTables();
        await prisma_1.prisma.$executeRawUnsafe(`
        INSERT INTO user_checkout_preferences (user_id, payment_method, selected_card_id, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET payment_method = EXCLUDED.payment_method,
          selected_card_id = EXCLUDED.selected_card_id,
          updated_at = NOW()
      `, req.user.userId, payload.methodCode, payload.cardId ?? null);
        res.json({ ok: true });
    }
    catch (error) {
        next(error);
    }
});
exports.checkoutRoutes.get('/cards', authMiddleware_1.requireAuth, async (req, res, next) => {
    try {
        await ensureCheckoutTables();
        const cards = await prisma_1.prisma.$queryRawUnsafe(`SELECT id, brand, last4, exp_month, exp_year
       FROM user_saved_cards
       WHERE user_id = $1
       ORDER BY created_at DESC`, req.user.userId);
        res.json({
            items: cards.map((card) => ({
                id: card.id,
                brand: card.brand,
                last4: card.last4,
                expMonth: card.exp_month,
                expYear: card.exp_year
            }))
        });
    }
    catch (error) {
        next(error);
    }
});
exports.checkoutRoutes.post('/cards', authMiddleware_1.requireAuth, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const payload = cardSchema.parse(req.body);
        await ensureCheckoutTables();
        const number = payload.cardNumber.replace(/\s+/g, '');
        const month = Number(payload.expMonth);
        const year = Number(payload.expYear);
        const id = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await prisma_1.prisma.$executeRawUnsafe(`
        INSERT INTO user_saved_cards (id, user_id, brand, last4, exp_month, exp_year)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, id, req.user.userId, getBrand(number), number.slice(-4), month, year);
        res.status(201).json({
            id,
            brand: getBrand(number),
            last4: number.slice(-4),
            expMonth: month,
            expYear: year
        });
    }
    catch (error) {
        next(error);
    }
});
