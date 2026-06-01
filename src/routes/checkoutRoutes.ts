import { Router } from 'express';
import { z } from 'zod';
import { authenticateOptional, type AuthRequest, requireAuth } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { prisma } from '../lib/prisma';
import { cdekService } from '../services/cdekService';

export const checkoutRoutes = Router();

const CHECKOUT_SOURCE = {
  CART: 'CART',
  BUY_NOW: 'BUY_NOW'
} as const;

type CheckoutSource = (typeof CHECKOUT_SOURCE)[keyof typeof CHECKOUT_SOURCE];

const sourceQuerySchema = z.object({
  source: z.enum(['CART', 'BUY_NOW']).optional()
});

const buyNowBodySchema = z.object({
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        variantId: z.string().min(1).optional(),
        quantity: z.number().int().min(1).max(999).default(1)
      })
    )
    .min(1)
});

const cartItemBodySchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  quantity: z.number().int().min(1).max(999).default(1)
});

const recipientSchema = z.object({
  name: z.string().min(2),
  phone: z.string().min(5),
  email: z.string().email()
});

const addressSchema = z.object({
  line1: z.string().min(3),
  city: z.string().min(2),
  postalCode: z.string().min(2),
  country: z.string().min(2),
  apartment: z.string().optional(),
  floor: z.string().optional(),
  comment: z.string().optional()
});

const pickupPointSchema = z.object({
  id: z.string().min(1),
  buyerPickupPointId: z.string().optional(),
  buyerPickupPlatformStationId: z.string().nullable().optional(),
  buyerPickupOperatorStationId: z.string().regex(/^\d+$/).nullable().optional(),
  operator_station_id: z.string().regex(/^\d+$/).nullable().optional(),
  fullAddress: z.string().min(1),
  country: z.string().optional(),
  locality: z.string().optional(),
  street: z.string().optional(),
  house: z.string().optional(),
  comment: z.string().optional(),
  city_code: z.number().int().positive().optional(),
  location: z.object({
    city_code: z.number().int().positive().optional(),
    city: z.string().optional(),
    latitude: z.number().optional(),
    longitude: z.number().optional(),
    address_full: z.string().optional()
  }).passthrough().optional(),
  position: z
    .object({
      lat: z.number().optional(),
      lng: z.number().optional()
    })
    .passthrough()
    .optional(),
  type: z.string().optional(),
  paymentMethods: z.array(z.string()).optional()
});

const pickupSchema = z.object({
  pickupPoint: pickupPointSchema,
  provider: z.string().min(1)
});

const deliveryMethodSchema = z.object({
  methodCode: z.enum(['ADDRESS', 'PICKUP', 'COURIER', 'PICKUP_POINT']),
  subType: z.string().optional()
});

const paymentMethodSchema = z.object({
  methodCode: z.enum(['CARD', 'SBP']),
  cardId: z.string().optional()
});

const cardSchema = z.object({
  cardNumber: z.string().min(12),
  expMonth: z.union([z.string(), z.number()]),
  expYear: z.union([z.string(), z.number()]),
  cvv: z.string().min(3).max(4)
});

type PreferencesRow = {
  user_id: string;
  delivery_method: 'ADDRESS' | 'PICKUP' | 'COURIER' | 'PICKUP_POINT';
  delivery_sub_type: string | null;
  delivery_provider: string | null;
  payment_method: 'CARD' | 'SBP';
  selected_card_id: string | null;
  pickup_point_id: string | null;
  pickup_provider: string | null;
  pickup_point_json: unknown;
};

type CardRow = {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
};

type CheckoutSessionRow = { id: string };

type CheckoutSessionItemRow = {
  product_id: string;
  variant_id: string | null;
  quantity: number;
};

const DELIVERY_METHODS = [
  { id: 'courier', code: 'COURIER', title: 'Курьером', description: 'Курьером до двери' },
  { id: 'pickup_point', code: 'PICKUP_POINT', title: 'Самовывоз', description: 'Пункт выдачи или постамат' }
] as const;

const PAYMENT_METHODS = [
  { id: 'card', code: 'CARD', title: 'Банковской картой' },
  { id: 'sbp', code: 'SBP', title: 'СБП' }
] as const;

let setupPromise: Promise<void> | null = null;

const ensureCheckoutTables = async () => {
  if (!setupPromise) {
    setupPromise = (async () => {
      await prisma.$executeRawUnsafe(`
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

      await prisma.$executeRawUnsafe(`
        ALTER TABLE user_checkout_preferences
          ADD COLUMN IF NOT EXISTS delivery_provider TEXT,
          ADD COLUMN IF NOT EXISTS pickup_point_json JSONB
      `);

      await prisma.$executeRawUnsafe(`
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

      await prisma.$executeRawUnsafe(`
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

      await prisma.$executeRawUnsafe(`
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

      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS idx_checkout_sessions_scope_source ON checkout_sessions(scope_key, source)'
      );
      await prisma.$executeRawUnsafe(
        'CREATE INDEX IF NOT EXISTS idx_checkout_session_items_session ON checkout_session_items(session_id)'
      );
    })().then(() => undefined);
  }

  return setupPromise;
};

const normalizeDeliveryMethod = (method: PreferencesRow['delivery_method'] | undefined | null) => {
  if (method === 'ADDRESS') return 'COURIER';
  if (method === 'PICKUP') return 'PICKUP_POINT';
  return method ?? 'COURIER';
};

const getBrand = (cardNumber: string) => {
  if (cardNumber.startsWith('4')) return 'VISA';
  if (cardNumber.startsWith('5')) return 'Mastercard';
  if (cardNumber.startsWith('2')) return 'МИР';
  return 'CARD';
};

const resolveScopeKey = (req: AuthRequest) => {
  if (req.user?.userId) {
    return { scopeKey: `user:${req.user.userId}`, userId: req.user.userId };
  }
  const guestToken = req.header('x-checkout-session-token')?.trim();
  if (!guestToken) {
    return null;
  }
  return { scopeKey: `guest:${guestToken}`, userId: null };
};

const getOrCreateSession = async (scopeKey: string, source: CheckoutSource) => {
  const existing = await prisma.$queryRawUnsafe<CheckoutSessionRow[]>(
    'SELECT id FROM checkout_sessions WHERE scope_key = $1 AND source = $2 LIMIT 1',
    scopeKey,
    source
  );

  if (existing[0]) {
    return existing[0].id;
  }

  const sessionId = `chk_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO checkout_sessions (id, scope_key, source, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, TRUE, NOW(), NOW())
     ON CONFLICT (scope_key, source)
     DO UPDATE SET is_active = TRUE, updated_at = NOW()`,
    sessionId,
    scopeKey,
    source
  );

  const createdOrExisting = await prisma.$queryRawUnsafe<CheckoutSessionRow[]>(
    'SELECT id FROM checkout_sessions WHERE scope_key = $1 AND source = $2 LIMIT 1',
    scopeKey,
    source
  );

  return createdOrExisting[0].id;
};

const replaceSessionItems = async (
  scopeKey: string,
  source: CheckoutSource,
  items: Array<{ productId: string; variantId?: string; quantity: number }>
) => {
  const deduped = new Map<string, { productId: string; variantId?: string; quantity: number }>();
  for (const item of items) {
    const key = `${item.productId}::${item.variantId ?? ''}`;
    deduped.set(key, item);
  }

  await prisma.$transaction(async (tx) => {
    const sessionId = await getOrCreateSession(scopeKey, source);
    await tx.$executeRawUnsafe('DELETE FROM checkout_session_items WHERE session_id = $1', sessionId);

    for (const item of deduped.values()) {
      const id = `itm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
      await tx.$executeRawUnsafe(
        `INSERT INTO checkout_session_items (id, session_id, product_id, variant_id, quantity, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
        id,
        sessionId,
        item.productId,
        item.variantId ?? null,
        item.quantity
      );
    }

    await tx.$executeRawUnsafe('UPDATE checkout_sessions SET updated_at = NOW() WHERE id = $1', sessionId);
  });
};

const upsertCartItem = async (
  scopeKey: string,
  item: { productId: string; variantId?: string; quantity: number }
) => {
  const sessionId = await getOrCreateSession(scopeKey, CHECKOUT_SOURCE.CART);
  const existing = await prisma.$queryRawUnsafe<Array<{ id: string; quantity: number }>>(
    `SELECT id, quantity
     FROM checkout_session_items
     WHERE session_id = $1 AND product_id = $2 AND COALESCE(variant_id, '') = COALESCE($3, '')
     LIMIT 1`,
    sessionId,
    item.productId,
    item.variantId ?? null
  );

  if (existing[0]) {
    await prisma.$executeRawUnsafe(
      'UPDATE checkout_session_items SET quantity = $2, updated_at = NOW() WHERE id = $1',
      existing[0].id,
      item.quantity
    );
  } else {
    await prisma.$executeRawUnsafe(
      `INSERT INTO checkout_session_items (id, session_id, product_id, variant_id, quantity, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
      `itm_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      sessionId,
      item.productId,
      item.variantId ?? null,
      item.quantity
    );
  }
};

const removeCartItem = async (scopeKey: string, productId: string, variantId?: string) => {
  const session = await prisma.$queryRawUnsafe<CheckoutSessionRow[]>(
    'SELECT id FROM checkout_sessions WHERE scope_key = $1 AND source = $2 LIMIT 1',
    scopeKey,
    CHECKOUT_SOURCE.CART
  );
  if (!session[0]) {
    return;
  }

  await prisma.$executeRawUnsafe(
    `DELETE FROM checkout_session_items
     WHERE session_id = $1 AND product_id = $2 AND COALESCE(variant_id, '') = COALESCE($3, '')`,
    session[0].id,
    productId,
    variantId ?? null
  );
};

const getCheckoutData = async ({
  userId,
  scopeKey,
  source
}: {
  userId: string | null;
  scopeKey: string;
  source: CheckoutSource;
}) => {
  await ensureCheckoutTables();

  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;
  const contact = userId ? await prisma.contact.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } }) : null;
  const defaultAddress = userId ? await prisma.address.findFirst({ where: { userId, isDefault: true } }) : null;

  const prefsRows = userId
    ? await prisma.$queryRawUnsafe<PreferencesRow[]>(
        'SELECT * FROM user_checkout_preferences WHERE user_id = $1 LIMIT 1',
        userId
      )
    : [];
  const prefs = prefsRows[0];

  const cards = userId
    ? await prisma.$queryRawUnsafe<CardRow[]>(
        `SELECT id, brand, last4, exp_month, exp_year
         FROM user_saved_cards
         WHERE user_id = $1
         ORDER BY created_at DESC`,
        userId
      )
    : [];

  const sessionRows = await prisma.$queryRawUnsafe<CheckoutSessionRow[]>(
    'SELECT id FROM checkout_sessions WHERE scope_key = $1 AND source = $2 LIMIT 1',
    scopeKey,
    source
  );

  const itemRows = sessionRows[0]
    ? await prisma.$queryRawUnsafe<CheckoutSessionItemRow[]>(
        `SELECT product_id, variant_id, quantity
         FROM checkout_session_items
         WHERE session_id = $1
         ORDER BY created_at DESC`,
        sessionRows[0].id
      )
    : [];

  const productIds = Array.from(new Set(itemRows.map((item) => item.product_id)));
  const products = productIds.length
    ? await prisma.product.findMany({
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
      if (!product) return null;

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
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  const parsedPickupPoint = pickupPointSchema.safeParse(prefs?.pickup_point_json);
  const pickupPointRaw = prefs?.pickup_point_json as Record<string, unknown> | null | undefined;
  const savedCityCode =
    Number((pickupPointRaw as any)?.cityCode ?? 0) ||
    Number((pickupPointRaw as any)?.city_code ?? 0) ||
    Number((pickupPointRaw as any)?.location?.city_code ?? 0) ||
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

checkoutRoutes.get('/', authenticateOptional, async (req: AuthRequest, res, next) => {
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
  } catch (error) {
    next(error);
  }
});

checkoutRoutes.get('/buy-now', authenticateOptional, async (req: AuthRequest, res, next) => {
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
  } catch (error) {
    return next(error);
  }
});

checkoutRoutes.post('/buy-now', authenticateOptional, writeLimiter, async (req: AuthRequest, res, next) => {
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
  } catch (error) {
    return next(error);
  }
});

checkoutRoutes.post('/cart/items', authenticateOptional, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const identity = resolveScopeKey(req);
    if (!identity) {
      return res.status(401).json({ error: { code: 'AUTH_OR_CHECKOUT_TOKEN_REQUIRED' } });
    }

    const payload = cartItemBodySchema.parse(req.body);
    await ensureCheckoutTables();
    await upsertCartItem(identity.scopeKey, payload);

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

checkoutRoutes.delete('/cart/items/:productId', authenticateOptional, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const identity = resolveScopeKey(req);
    if (!identity) {
      return res.status(401).json({ error: { code: 'AUTH_OR_CHECKOUT_TOKEN_REQUIRED' } });
    }

    const variantId = typeof req.query.variantId === 'string' ? req.query.variantId : undefined;
    await ensureCheckoutTables();
    await removeCartItem(identity.scopeKey, req.params.productId, variantId);

    return res.json({ ok: true });
  } catch (error) {
    return next(error);
  }
});

checkoutRoutes.put('/recipient', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = recipientSchema.parse(req.body);
    const existing = await prisma.contact.findFirst({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: 'desc' }
    });

    if (existing) {
      await prisma.contact.update({
        where: { id: existing.id },
        data: { name: payload.name, phone: payload.phone, email: payload.email }
      });
    } else {
      await prisma.contact.create({
        data: { userId: req.user!.userId, name: payload.name, phone: payload.phone, email: payload.email }
      });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

checkoutRoutes.put('/address', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = addressSchema.parse(req.body);
    const existing = await prisma.address.findFirst({ where: { userId: req.user!.userId, isDefault: true } });

    if (existing) {
      await prisma.address.update({
        where: { id: existing.id },
        data: {
          addressText: payload.line1,
          apartment: payload.apartment,
          floor: payload.floor,
          courierComment: payload.comment
        }
      });
    } else {
      await prisma.address.create({
        data: {
          userId: req.user!.userId,
          addressText: payload.line1,
          apartment: payload.apartment,
          floor: payload.floor,
          courierComment: payload.comment,
          isDefault: true
        }
      });
    }

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

checkoutRoutes.put('/pickup', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = pickupSchema.parse(req.body);

    const buyerPickupPvzId = payload.pickupPoint.id.trim();
    if (!buyerPickupPvzId) {
      return res.status(400).json({
        error: { code: 'VALIDATION_ERROR', message: 'pickupPoint.id обязателен.' }
      });
    }

    // Try to get city_code from payload first (may not be present if coming from CDEK widget v3)
    let cityCode =
      Number(payload.pickupPoint.city_code ?? 0) ||
      Number(payload.pickupPoint.location?.city_code ?? 0) ||
      0;

    // Widget v3 doesn't return city_code — resolve it from CDEK API by PVZ code
    if (cityCode <= 0) {
      try {
        const resolved = await cdekService.getCityCodeByPvzCode(buyerPickupPvzId);
        if (resolved) cityCode = resolved;
      } catch (err) {
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

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO user_checkout_preferences (user_id, pickup_point_id, pickup_provider, pickup_point_json, delivery_provider, updated_at)
        VALUES ($1, $2, $3, $4::jsonb, $3, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET pickup_point_id = EXCLUDED.pickup_point_id,
          pickup_provider = EXCLUDED.pickup_provider,
          pickup_point_json = EXCLUDED.pickup_point_json,
          delivery_provider = EXCLUDED.delivery_provider,
          delivery_method = 'PICKUP_POINT',
          updated_at = NOW()
      `,
      req.user!.userId,
      buyerPickupPvzId,
      payload.provider,
      JSON.stringify(pickupPointJson)
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

checkoutRoutes.put('/delivery-method', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = deliveryMethodSchema.parse(req.body);
    const normalizedMethod = normalizeDeliveryMethod(payload.methodCode);
    await ensureCheckoutTables();

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO user_checkout_preferences (user_id, delivery_method, delivery_sub_type, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET delivery_method = EXCLUDED.delivery_method,
          delivery_sub_type = EXCLUDED.delivery_sub_type,
          pickup_point_id = CASE WHEN EXCLUDED.delivery_method = 'COURIER' THEN NULL ELSE user_checkout_preferences.pickup_point_id END,
          pickup_provider = CASE WHEN EXCLUDED.delivery_method = 'COURIER' THEN NULL ELSE user_checkout_preferences.pickup_provider END,
          pickup_point_json = CASE WHEN EXCLUDED.delivery_method = 'COURIER' THEN NULL ELSE user_checkout_preferences.pickup_point_json END,
          updated_at = NOW()
      `,
      req.user!.userId,
      normalizedMethod,
      payload.subType ?? null
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

checkoutRoutes.put('/payment-method', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = paymentMethodSchema.parse(req.body);
    await ensureCheckoutTables();

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO user_checkout_preferences (user_id, payment_method, selected_card_id, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (user_id)
        DO UPDATE SET payment_method = EXCLUDED.payment_method,
          selected_card_id = EXCLUDED.selected_card_id,
          updated_at = NOW()
      `,
      req.user!.userId,
      payload.methodCode,
      payload.cardId ?? null
    );

    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

checkoutRoutes.get('/cards', requireAuth, async (req: AuthRequest, res, next) => {
  try {
    await ensureCheckoutTables();

    const cards = await prisma.$queryRawUnsafe<CardRow[]>(
      `SELECT id, brand, last4, exp_month, exp_year
       FROM user_saved_cards
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      req.user!.userId
    );

    res.json({
      items: cards.map((card) => ({
        id: card.id,
        brand: card.brand,
        last4: card.last4,
        expMonth: card.exp_month,
        expYear: card.exp_year
      }))
    });
  } catch (error) {
    next(error);
  }
});

checkoutRoutes.post('/cards', requireAuth, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = cardSchema.parse(req.body);
    await ensureCheckoutTables();

    const number = payload.cardNumber.replace(/\s+/g, '');
    const month = Number(payload.expMonth);
    const year = Number(payload.expYear);
    const id = `card_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    await prisma.$executeRawUnsafe(
      `
        INSERT INTO user_saved_cards (id, user_id, brand, last4, exp_month, exp_year)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      id,
      req.user!.userId,
      getBrand(number),
      number.slice(-4),
      month,
      year
    );

    res.status(201).json({
      id,
      brand: getBrand(number),
      last4: number.slice(-4),
      expMonth: month,
      expYear: year
    });
  } catch (error) {
    next(error);
  }
});
