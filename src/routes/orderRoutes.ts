import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { prisma } from '../lib/prisma';
import { orderUseCases } from '../usecases/orderUseCases';
import { canRetryPayment, computePaymentTiming, expirePendingPayments } from '../utils/orderPayment';
import { paymentFlowService } from '../services/paymentFlowService';
import { withOrderPublicId } from '../utils/orderPublicId';
import { formatOrderFinancials } from '../utils/orderFinancials';
import { quoteCheckoutShipping } from '../services/checkoutShippingService';
import { resolveDeliveryStatusLabel } from '../utils/deliveryLabels';

// Extracts city_code from CDEK PVZ metadata regardless of nesting depth
const extractCityCode = (meta: unknown): number => {
  const rec = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
  const m = rec(meta);
  const r = rec(m.raw);
  const rr = rec(r.raw);
  const loc = rec(r.location);
  const rrloc = rec(rr.location);
  return (
    num(m.cityCode) ||
    num(m.city_code) ||
    num(r.cityCode) ||
    num(r.city_code) ||
    num(loc.city_code) ||
    num(rr.city_code) ||
    num(rrloc.city_code) ||
    0
  );
};
import {
  BUYER_PUBLIC_SELECT,
  financialsForBuyer,
  financialsForSeller,
  stripInternalOrderFields
} from '../utils/serializers';

export const orderRoutes = Router();

const buyerPvzSelectionSchema = z.object({
  provider: z.string().optional(),
  pvzId: z.string().min(1),
  addressFull: z.string().optional(),
  country: z.string().optional(),
  locality: z.string().optional(),
  street: z.string().optional(),
  house: z.string().optional(),
  comment: z.string().optional(),
  raw: z.unknown()
});

const cdekPvzRawSchema = z.object({
  city_code: z.number().int().positive(),
  city: z.string().optional(),
  address_full: z.string().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  work_time: z.string().optional()
});

const createOrderSchema = z.object({
  paymentAttemptKey: z.string().trim().min(6),
  buyerPickupPvz: buyerPvzSelectionSchema.optional(),
  cdekPvzCode: z.string().min(1).optional(),
  cdekPvzAddress: z.string().optional(),
  cdekPvzCityCode: z.number().int().positive().optional(),
  cdekPvzRaw: cdekPvzRawSchema.optional(),
  deliveryMethod: z.enum(['courier', 'cdek_pvz']).optional(),
  contactId: z.string().optional(),
  shippingAddressId: z.string().optional(),
  items: z
    .array(
      z.object({
        productId: z.string(),
        variantId: z.string().optional(),
        quantity: z.number().int().min(1).max(999)
      })
    )
    .min(1)
});

export const sameCheckout = (order: { items: { productId: string; variantId: string | null; quantity: number }[];
  buyerPickupPvzId: string | null; contactId: string | null; shippingAddressId: string | null },
  payload: z.infer<typeof createOrderSchema>) =>
  (order.contactId ?? null) === (payload.contactId ?? null) &&
  (order.shippingAddressId ?? null) === (payload.shippingAddressId === 'cdek_pvz' ? null : payload.shippingAddressId ?? null) &&
  order.items.length === payload.items.length &&
  payload.items.every(item => order.items.some(saved => saved.productId === item.productId &&
    (saved.variantId ?? undefined) === item.variantId && saved.quantity === item.quantity)) &&
  order.buyerPickupPvzId === (payload.cdekPvzCode ?? payload.buyerPickupPvz?.pvzId ?? null);

const findCheckoutAttempt = (buyerId: string, paymentAttemptKey: string) => prisma.order.findFirst({
  where: { buyerId, paymentAttemptKey },
  include: { items: { include: { product: true, variant: true } }, contact: true, shippingAddress: true }
});

orderRoutes.post('/', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    await expirePendingPayments();
    const payload = createOrderSchema.parse(req.body);
    const { cdekPvzCode, deliveryMethod, cdekPvzRaw, cdekPvzCityCode } = payload as {
      cdekPvzCode?: string;
      cdekPvzRaw?: z.infer<typeof cdekPvzRawSchema>;
      cdekPvzCityCode?: number;
      deliveryMethod?: 'courier' | 'cdek_pvz';
    };

    const prior = await findCheckoutAttempt(req.user!.userId, payload.paymentAttemptKey);
    if (prior) return sameCheckout(prior, payload)
      ? res.status(200).json({ data: withOrderPublicId(prior), orderId: prior.id })
      : res.status(409).json({ error: { code: 'CHECKOUT_CHANGED' } });

    if (deliveryMethod === 'cdek_pvz' && !cdekPvzCode) {
      return res.status(400).json({ error: { code: 'CDEK_PVZ_CODE_REQUIRED', message: 'cdekPvzCode is required for cdek_pvz', details: null } });
    }

    const resolvedBuyerCityCode = Number(cdekPvzCityCode ?? cdekPvzRaw?.city_code ?? 0);
    const productIds = payload.items.map((item) => item.productId);
    const uniqueProductIds = Array.from(new Set(productIds));
    const products = await prisma.product.findMany({
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

    const sellerSettings = await prisma.sellerSettings.findUnique({ where: { sellerId: sellerIds[0] } });

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

    const sellerDropoffMeta = sellerSettings?.defaultDropoffPvzMeta as Record<string, unknown> | null;
    const sellerDropoffRaw = sellerDropoffMeta && typeof sellerDropoffMeta === 'object'
      ? (sellerDropoffMeta.raw ?? {})
      : {};
    const sellerDropoffAddress = sellerDropoffMeta && typeof sellerDropoffMeta === 'object'
      ? String(sellerDropoffMeta.addressFull ?? '')
      : undefined;

    const buyerCityCode = resolvedBuyerCityCode > 0 ? resolvedBuyerCityCode : extractCityCode(payload.buyerPickupPvz);
    const shipping = await quoteCheckoutShipping(payload.items, {
      pvzId: cdekPvzCode ?? payload.buyerPickupPvz?.pvzId,
      raw: { city_code: buyerCityCode }
    });
    const { deliveryAmountKopecks } = shipping;
    const deliveryDaysMin = shipping.quote.deliveryDaysMin;
    const deliveryDaysMax = shipping.quote.deliveryDaysMax;

    const order = await orderUseCases.create({
      buyerId: req.user!.userId,
      paymentAttemptKey: payload.paymentAttemptKey,
      contactId: payload.contactId,
      shippingAddressId: payload.shippingAddressId,
      items: payload.items,
      buyerPickupPvz: shipping.buyerPickupPvz,
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
      deliveryDaysMax,
      shippingSnapshot: shipping.snapshot
    });

    return res.status(201).json({ data: withOrderPublicId(order), orderId: order.id });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const key = typeof req.body?.paymentAttemptKey === 'string' ? req.body.paymentAttemptKey : '';
      const prior = key ? await findCheckoutAttempt(req.user!.userId, key) : null;
      if (prior) {
        const parsed = createOrderSchema.safeParse(req.body);
        return parsed.success && sameCheckout(prior, parsed.data)
          ? res.status(200).json({ data: withOrderPublicId(prior), orderId: prior.id })
          : res.status(409).json({ error: { code: 'CHECKOUT_CHANGED' } });
      }
    }
    const code = error instanceof Error ? error.message : '';
    if (['PRODUCT_NOT_FOUND', 'SELLER_NOT_AVAILABLE', 'VARIANT_INVALID', 'DUPLICATE_ORDER_ITEM', 'QUANTITY_INVALID', 'PRODUCT_PRICE_INVALID', 'CONTACT_NOT_FOUND', 'SHIPPING_ADDRESS_NOT_FOUND'].includes(code)) {
      return res.status(code === 'PRODUCT_NOT_FOUND' ? 404 : 400).json({ error: { code } });
    }
    if (code === 'PVZ_INVALID') return res.status(400).json({ error: { code } });
    if (code === 'CDEK_PVZ_LOOKUP_FAILED') return res.status(503).json({ error: { code } });
    return next(error);
  }
});

orderRoutes.post('/:id/pay', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const order = await prisma.order.findFirst({ where: { id: req.params.id, buyerId: req.user!.userId } });
    if (!order) {
      return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
    }
    return res.status(409).json({ error: { code: 'PAYMENT_FLOW_CHANGED', message: 'Use POST /payments/start for payment flow' } });
  } catch (error) {
    return next(error);
  }
});

orderRoutes.post('/:orderId/retry-payment', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const retried = await paymentFlowService.retryPayment(req.params.orderId, req.user!.userId);
    return res.json({ ok: true, data: retried });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    if (code === 'ORDER_NOT_FOUND') return res.status(404).json({ error: { code } });
    if (['ORDER_ALREADY_PAID', 'PAYMENT_RETRY_FORBIDDEN', 'PAYMENT_ATTEMPT_ACTIVE', 'PAYMENT_ATTEMPT_UNVERIFIED', 'SHIPPING_REQUOTE_REQUIRED'].includes(code)) {
      return res.status(409).json({ error: { code } });
    }
    if (['PAYMENT_PROVIDER_UNAVAILABLE', 'PAYMENT_PROVIDER_MISMATCH', 'PAYMENT_RECONCILIATION_REQUIRED'].includes(code)) {
      return res.status(503).json({ error: { code } });
    }
    return next(error);
  }
});

orderRoutes.post('/:id/ready-for-shipment', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  return res.status(410).json({ error: { code: 'USE_SELLER_READY_TO_SHIP' } });
});


orderRoutes.post('/:orderId/cancel', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const { order, refund } = await paymentFlowService.cancelBuyerOrder(req.params.orderId, req.user!.userId);

    return res.json({ data: withOrderPublicId(order), refund });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    if (message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({ error: { code: message } });
    }
    if (
      message === 'ORDER_NOT_PAID' ||
      message === 'ORDER_CANNOT_CANCEL' ||
      message === 'PRODUCTION_ALREADY_STARTED' ||
      message === 'ORDER_ALREADY_SHIPPED' ||
      message === 'REFUND_AMOUNT_EXCEEDS_PAYMENT' ||
      message === 'PAYMENT_EXTERNAL_ID_NOT_FOUND'
    ) {
      return res.status(409).json({ error: { code: message } });
    }
    if (message === 'REFUND_CREATE_FAILED') {
      return res.status(502).json({ error: { code: message } });
    }
    return next(error);
  }
});

orderRoutes.get('/me', authenticate, async (req: AuthRequest, res, next) => {
  try {
    await expirePendingPayments();
    const orders = await prisma.order.findMany({
      where: { buyerId: req.user!.userId },
      include: { items: { include: { product: true, variant: true } }, shipment: true, deliveryEvents: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({
      data: orders.map((order) => {
        const timing = computePaymentTiming(order);
        const base = stripInternalOrderFields(withOrderPublicId(order) as Record<string, unknown>);
        return {
          ...base,
          ...timing,
          canRetryPayment: canRetryPayment(order),
          retryPaymentAvailable: canRetryPayment(order),
          financials: financialsForBuyer(order),
          deliveryStatusLabel: resolveDeliveryStatusLabel(order),
          deliveryEta: order.deliveryDaysMin && order.deliveryDaysMax
            ? { daysMin: order.deliveryDaysMin, daysMax: order.deliveryDaysMax, text: order.deliveryEtaText ?? null }
            : null
        };
      })
    });
  } catch (error) {
    next(error);
  }
});

orderRoutes.get('/:id/delivery/history', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        OR: [{ buyerId: req.user!.userId }, { items: { some: { product: { sellerId: req.user!.userId } } } }]
      },
      include: { deliveryEvents: { orderBy: { createdAt: 'desc' } } }
    });
    if (!order) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    return res.json({ data: order.deliveryEvents });
  } catch (error) {
    return next(error);
  }
});

orderRoutes.get('/:id', authenticate, async (req, res, next) => {
  try {
    const userId = req.user!.userId;
    const order = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        OR: [{ buyerId: userId }, { items: { some: { product: { sellerId: userId } } } }]
      },
      include: {
        items: { include: { product: true, variant: true } },
        contact: true,
        shippingAddress: true,
        buyer: { select: BUYER_PUBLIC_SELECT },
        deliveryEvents: { orderBy: { createdAt: 'desc' } }
      }
    });
    if (!order) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }

    const isSeller = order.items.some((item) => item.product.sellerId === userId);
    const base = withOrderPublicId(order) as Record<string, unknown>;
    const deliveryStatusLabel = resolveDeliveryStatusLabel(order);
    const deliveryEta = order.deliveryDaysMin && order.deliveryDaysMax
      ? { daysMin: order.deliveryDaysMin, daysMax: order.deliveryDaysMax, text: order.deliveryEtaText ?? null }
      : null;

    if (isSeller) {
      return res.json({
        data: { ...base, financials: financialsForSeller(order), deliveryStatusLabel, deliveryEta }
      });
    }

    return res.json({
      data: {
        ...stripInternalOrderFields(base),
        ...computePaymentTiming(order),
        canRetryPayment: canRetryPayment(order),
        financials: financialsForBuyer(order),
        deliveryStatusLabel,
        deliveryEta
      }
    });
  } catch (error) {
    return next(error);
  }
});
