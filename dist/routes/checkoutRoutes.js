"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkoutRoutes = void 0;
const express_1 = require("express");
const zod_1 = require("zod");
const authMiddleware_1 = require("../middleware/authMiddleware");
const rateLimiters_1 = require("../middleware/rateLimiters");
const prisma_1 = require("../lib/prisma");
const cdekService_1 = require("../services/cdekService");
exports.checkoutRoutes = (0, express_1.Router)();
const CHECKOUT_SOURCE = {
    CART: 'CART',
    BUY_NOW: 'BUY_NOW'
};
const sourceQuerySchema = zod_1.z.object({
    source: zod_1.z.enum(['CART', 'BUY_NOW']).optional()
});
const buyNowBodySchema = zod_1.z.object({
    items: zod_1.z
        .array(zod_1.z.object({
        productId: zod_1.z.string().min(1),
        variantId: zod_1.z.string().min(1).optional(),
        quantity: zod_1.z.number().int().min(1).max(999).default(1)
    }))
        .min(1)
});
const cartItemBodySchema = zod_1.z.object({
    productId: zod_1.z.string().min(1),
    variantId: zod_1.z.string().min(1).optional(),
    quantity: zod_1.z.number().int().min(1).max(999).default(1)
});
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
    id: zod_1.z.string().min(1),
    buyerPickupPointId: zod_1.z.string().optional(),
    buyerPickupPlatformStationId: zod_1.z.string().nullable().optional(),
    buyerPickupOperatorStationId: zod_1.z.string().regex(/^\d+$/).nullable().optional(),
    operator_station_id: zod_1.z.string().regex(/^\d+$/).nullable().optional(),
    fullAddress: zod_1.z.string().min(1),
    country: zod_1.z.string().optional(),
    locality: zod_1.z.string().optional(),
    street: zod_1.z.string().optional(),
    house: zod_1.z.string().optional(),
    comment: zod_1.z.string().optional(),
    city_code: zod_1.z.number().int().positive().optional(),
    location: zod_1.z.object({
        city_code: zod_1.z.number().int().positive().optional(),
        city: zod_1.z.string().optional(),
        latitude: zod_1.z.number().optional(),
        longitude: zod_1.z.number().optional(),
        address_full: zod_1.z.string().optional()
    }).passthrough().optional(),
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
            await prisma_1.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS checkout_sessions (
          id TEXT PRIMARY KEY,
          scope_key TEXT NOT NULL,
          source TEXT NOT NULL,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (scope_key, source)
        )
      `);
            await prisma_1.prisma.$executeRawUnsafe(`
        CREATE TABLE IF NOT EXISTS checkout_session_items (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES checkout_sessions(id) ON DELETE CASCADE,
          product_id TEXT NOT NULL,
          variant_id TEXT,
          quantity INT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (session_id, product_id, variant_id)
        )
      `);
            await prisma_1.prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_checkout_sessions_scope_source ON checkout_sessions(scope_key, source)');
            await prisma_1.prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS idx_checkout_session_items_session ON checkout_session_items(session_id)');
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
const resolveScopeKey = (req) => {
    if (req.user?.userId) {
        return { scopeKey: `user:${req.user.userId}`, userId: req.user.userId };
    }
    const guestToken = req.header('x-checkout-session-token')?.trim();
    if (!guestToken) {
        return null;
    }
    return { scopeKey: `guest:${guestToken}`, userId: null };
};
const getOrCreateSession = async (scopeKey, source) => {
    const existing = await prisma_1.prisma.$queryRawUnsafe('SELECT id FROM checkout_sessions WHERE scope_key = $1 AND source = $2 LIMIT 1', scopeKey, source);
    if (existing[0]) {
        return existing[0].id;
    }
    const sessionId = `chk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await prisma_1.prisma.$executeRawUnsafe(`INSERT INTO checkout_sessions (id, scope_key, source, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, TRUE, NOW(), NOW())
     ON CONFLICT (scope_key, source)
     DO UPDATE SET is_active = TRUE, updated_at = NOW()`, sessionId, scopeKey, source);
    const createdOrExisting = await prisma_1.prisma.$queryRawUnsafe('SELECT id FROM checkout_sessions WHERE scope_key = $1 AND source = $2 LIMIT 1', scopeKey, source);
    return createdOrExisting[0].id;
};
const replaceSessionItems = async (scopeKey, source, items) => {
    const deduped = new Map();
    for (const item of items) {
        const key = `${item.productId}::${item.variantId ?? ''}`;
        deduped.set(key, item);
    }
    await prisma_1.prisma.$transaction(async (tx) => {
        const sessionId = await getOrCreateSession(scopeKey, source);
        await tx.$executeRawUnsafe('DELETE FROM checkout_session_items WHERE session_id = $1', sessionId);
        for (const item of deduped.values()) {
            const id = `itm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
            await tx.$executeRawUnsafe(`INSERT INTO checkout_session_items (id, session_id, product_id, variant_id, quantity, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`, id, sessionId, item.productId, item.variantId ?? null, item.quantity);
        }
        await tx.$executeRawUnsafe('UPDATE checkout_sessions SET updated_at = NOW() WHERE id = $1', sessionId);
    });
};
const upsertCartItem = async (scopeKey, item) => {
    const sessionId = await getOrCreateSession(scopeKey, CHECKOUT_SOURCE.CART);
    const existing = await prisma_1.prisma.$queryRawUnsafe(`SELECT id, quantity
     FROM checkout_session_items
     WHERE session_id = $1 AND product_id = $2 AND COALESCE(variant_id, '') = COALESCE($3, '')
     LIMIT 1`, sessionId, item.productId, item.variantId ?? null);
    if (existing[0]) {
        await prisma_1.prisma.$executeRawUnsafe('UPDATE checkout_session_items SET quantity = $2, updated_at = NOW() WHERE id = $1', existing[0].id, item.quantity);
    }
    else {
        await prisma_1.prisma.$executeRawUnsafe(`INSERT INTO checkout_session_items (id, session_id, product_id, variant_id, quantity, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`, `itm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`, sessionId, item.productId, item.variantId ?? null, item.quantity);
    }
};
const removeCartItem = async (scopeKey, productId, variantId) => {
    const session = await prisma_1.prisma.$queryRawUnsafe('SELECT id FROM checkout_sessions WHERE scope_key = $1 AND source = $2 LIMIT 1', scopeKey, CHECKOUT_SOURCE.CART);
    if (!session[0]) {
        return;
    }
    await prisma_1.prisma.$executeRawUnsafe(`DELETE FROM checkout_session_items
     WHERE session_id = $1 AND product_id = $2 AND COALESCE(variant_id, '') = COALESCE($3, '')`, session[0].id, productId, variantId ?? null);
};
const getCheckoutData = async ({ userId, scopeKey, source }) => {
    await ensureCheckoutTables();
    const user = userId ? await prisma_1.prisma.user.findUnique({ where: { id: userId } }) : null;
    const contact = userId ? await prisma_1.prisma.contact.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }) : null;
    const defaultAddress = userId ? await prisma_1.prisma.address.findFirst({ where: { userId, isDefault: true } }) : null;
    const prefsRows = userId
        ? await prisma_1.prisma.$queryRawUnsafe('SELECT * FROM user_checkout_preferences WHERE user_id = $1 LIMIT 1', userId)
        : [];
    const prefs = prefsRows[0];
    const cards = userId
        ? await prisma_1.prisma.$queryRawUnsafe(`SELECT id, brand, last4, exp_month, exp_year
         FROM user_saved_cards
         WHERE user_id = $1
         ORDER BY created_at DESC`, userId)
        : [];
    const sessionRows = await prisma_1.prisma.$queryRawUnsafe('SELECT id FROM checkout_sessions WHERE scope_key = $1 AND source = $2 LIMIT 1', scopeKey, source);
    const itemRows = sessionRows[0]
        ? await prisma_1.prisma.$queryRawUnsafe(`SELECT product_id, variant_id, quantity
         FROM checkout_session_items
         WHERE session_id = $1
         ORDER BY created_at DESC`, sessionRows[0].id)
        : [];
    const productIds = Array.from(new Set(itemRows.map((item) => item.product_id)));
    const products = productIds.length
        ? await prisma_1.prisma.product.findMany({
            where: {
                id: { in: productIds },
                moderationStatus: 'APPROVED',
                deletedAt: null
            },
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
        })
        : [];
    const productMap = new Map(products.map((product) => [product.id, product]));
    const cartItems = itemRows
        .map((item) => {
        const product = productMap.get(item.product_id);
        if (!product)
            return null;
        return {
            productId: product.id,
            variantId: item.variant_id,
            title: product.title,
            price: product.price,
            quantity: item.quantity,
            image: product.image,
            shortSpec: product.descriptionShort || product.sku,
            productionTimeHours: 24,
            deliveryDays: null,
            etaMinDays: null,
            etaMaxDays: null,
            dimensions: product.dxCm && product.dyCm && product.dzCm ? { dxCm: product.dxCm, dyCm: product.dyCm, dzCm: product.dzCm } : null,
            weightGrossG: product.weightGrossG ?? null
        };
    })
        .filter((item) => Boolean(item));
    const parsedPickupPoint = pickupPointSchema.safeParse(prefs?.pickup_point_json);
    const pickupPointRaw = prefs?.pickup_point_json;
    const savedCityCode = Number(pickupPointRaw?.cityCode ?? 0) ||
        Number(pickupPointRaw?.city_code ?? 0) ||
        Number(pickupPointRaw?.location?.city_code ?? 0) ||
        0;
    return {
        source,
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
        selectedPickupPoint: parsedPickupPoint.success
            ? { ...parsedPickupPoint.data, cityCode: savedCityCode > 0 ? savedCityCode : undefined }
            : null,
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
exports.checkoutRoutes.get('/', authMiddleware_1.authenticateOptional, async (req, res, next) => {
    try {
        const params = sourceQuerySchema.parse(req.query);
        const identity = resolveScopeKey(req);
        if (!identity) {
            return res.status(401).json({ error: { code: 'AUTH_OR_CHECKOUT_TOKEN_REQUIRED' } });
        }
        const data = await getCheckoutData({
            scopeKey: identity.scopeKey,
            userId: identity.userId,
            source: params.source ?? CHECKOUT_SOURCE.CART
        });
        res.json(data);
    }
    catch (error) {
        next(error);
    }
});
exports.checkoutRoutes.get('/buy-now', authMiddleware_1.authenticateOptional, async (req, res, next) => {
    try {
        const identity = resolveScopeKey(req);
        if (!identity) {
            return res.status(401).json({ error: { code: 'AUTH_OR_CHECKOUT_TOKEN_REQUIRED' } });
        }
        const data = await getCheckoutData({
            scopeKey: identity.scopeKey,
            userId: identity.userId,
            source: CHECKOUT_SOURCE.BUY_NOW
        });
        return res.json(data);
    }
    catch (error) {
        return next(error);
    }
});
exports.checkoutRoutes.post('/buy-now', authMiddleware_1.authenticateOptional, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const identity = resolveScopeKey(req);
        if (!identity) {
            return res.status(401).json({ error: { code: 'AUTH_OR_CHECKOUT_TOKEN_REQUIRED' } });
        }
        const payload = buyNowBodySchema.parse(req.body);
        await ensureCheckoutTables();
        await replaceSessionItems(identity.scopeKey, CHECKOUT_SOURCE.BUY_NOW, payload.items);
        const data = await getCheckoutData({
            scopeKey: identity.scopeKey,
            userId: identity.userId,
            source: CHECKOUT_SOURCE.BUY_NOW
        });
        return res.status(200).json({ ok: true, data });
    }
    catch (error) {
        return next(error);
    }
});
exports.checkoutRoutes.post('/cart/items', authMiddleware_1.authenticateOptional, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const identity = resolveScopeKey(req);
        if (!identity) {
            return res.status(401).json({ error: { code: 'AUTH_OR_CHECKOUT_TOKEN_REQUIRED' } });
        }
        const payload = cartItemBodySchema.parse(req.body);
        await ensureCheckoutTables();
        await upsertCartItem(identity.scopeKey, payload);
        return res.json({ ok: true });
    }
    catch (error) {
        return next(error);
    }
});
exports.checkoutRoutes.delete('/cart/items/:productId', authMiddleware_1.authenticateOptional, rateLimiters_1.writeLimiter, async (req, res, next) => {
    try {
        const identity = resolveScopeKey(req);
        if (!identity) {
            return res.status(401).json({ error: { code: 'AUTH_OR_CHECKOUT_TOKEN_REQUIRED' } });
        }
        const variantId = typeof req.query.variantId === 'string' ? req.query.variantId : undefined;
        await ensureCheckoutTables();
        await removeCartItem(identity.scopeKey, req.params.productId, variantId);
        return res.json({ ok: true });
    }
    catch (error) {
        return next(error);
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
        // Try to get city_code from payload first (may not be present if coming from CDEK widget v3)
        let cityCode = Number(payload.pickupPoint.city_code ?? 0) ||
            Number(payload.pickupPoint.location?.city_code ?? 0) ||
            0;
        // Widget v3 doesn't return city_code — resolve it from CDEK API by PVZ code
        if (cityCode <= 0) {
            try {
                const resolved = await cdekService_1.cdekService.getCityCodeByPvzCode(buyerPickupPvzId);
                if (resolved)
                    cityCode = resolved;
            }
            catch (err) {
                console.warn('[CHECKOUT][pickup] failed to resolve city_code from CDEK', { pvzCode: buyerPickupPvzId, err });
            }
        }
        const pickupPointJson = {
            ...payload.pickupPoint,
            id: buyerPickupPvzId,
            buyerPickupPvzId,
            addressFull: payload.pickupPoint.fullAddress,
            ...(cityCode > 0 ? { cityCode, city_code: cityCode } : {})
        };
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
