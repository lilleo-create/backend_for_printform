import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { prisma } from '../lib/prisma';
import { orderUseCases } from '../usecases/orderUseCases';
import { canRetryPayment, computePaymentTiming, expirePendingPayments } from '../utils/orderPayment';
import { paymentFlowService } from '../services/paymentFlowService';
import { withOrderPublicId } from '../utils/orderPublicId';
import { formatOrderFinancials } from '../utils/orderFinancials';
import { cdekService } from '../services/cdekService';
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
        quantity: z.number().int().min(1)
      })
    )
    .min(1)
});

orderRoutes.post('/', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    await expirePendingPayments();
    const payload = createOrderSchema.parse(req.body);
    const { cdekPvzCode, cdekPvzAddress, deliveryMethod, cdekPvzRaw, cdekPvzCityCode } = payload as {
      cdekPvzCode?: string;
      cdekPvzAddress?: string;
      cdekPvzRaw?: z.infer<typeof cdekPvzRawSchema>;
      cdekPvzCityCode?: number;
      deliveryMethod?: 'courier' | 'cdek_pvz';
    };

    if (deliveryMethod === 'cdek_pvz' && !cdekPvzCode) {
      return res.status(400).json({ error: { code: 'CDEK_PVZ_CODE_REQUIRED', message: 'cdekPvzCode is required for cdek_pvz', details: null } });
    }

    const resolvedBuyerCityCode = Number(cdekPvzCityCode ?? cdekPvzRaw?.city_code ?? 0);
    if (deliveryMethod === 'cdek_pvz' && (!Number.isFinite(resolvedBuyerCityCode) || resolvedBuyerCityCode <= 0)) {
      return res.status(400).json({ error: { code: 'CITY_CODE_MISSING', message: 'cdekPvzCityCode or cdekPvzRaw.city_code is required', details: null } });
    }

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

    // Calculate delivery cost before creating the order so seller sees it immediately
    let deliveryAmountKopecks = 0;
    let deliveryDaysMin: number | undefined;
    let deliveryDaysMax: number | undefined;
    const sellerCityCode = extractCityCode(sellerDropoffMeta);
    const buyerCityCode = resolvedBuyerCityCode > 0
      ? resolvedBuyerCityCode
      : extractCityCode(payload.buyerPickupPvz);
    if (sellerCityCode > 0 && buyerCityCode > 0) {
      try {
        const quote = await cdekService.calculateDelivery({
          fromCityCode: sellerCityCode,
          toCityCode: buyerCityCode,
          weightGrams: 500
        });
        deliveryAmountKopecks = Math.round(quote.totalSum * 100);
        deliveryDaysMin = quote.deliveryDaysMin || undefined;
        deliveryDaysMax = quote.deliveryDaysMax || undefined;
      } catch (calcErr) {
        console.warn('[ORDER][delivery-cost-calc-failed]', { sellerCityCode, buyerCityCode: resolvedBuyerCityCode, calcErr });
      }
    }

    const order = await orderUseCases.create({
      buyerId: req.user!.userId,
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

    return res.status(201).json({ data: withOrderPublicId(order), orderId: order.id });
  } catch (error) {
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
    return next(error);
  }
});

orderRoutes.post('/:id/ready-for-shipment', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        status: 'PAID',
        items: { some: { product: { sellerId: req.user!.userId } } }
      }
    });

    if (!order) {
      return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });
    }

    const now = new Date();
    const updated = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'READY_FOR_SHIPMENT',
        readyForShipmentAt: now,
        dropoffDeadlineAt: new Date(now.getTime() + 24 * 60 * 60 * 1000)
      }
    });
    return res.json({ data: withOrderPublicId(updated) });
  } catch (error) {
    return next(error);
  }
});


orderRoutes.post('/:orderId/cancel', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const { order, refund } = await paymentFlowService.createOrderCancellationRefund({
      orderId: req.params.orderId,
      buyerId: req.user!.userId
    });

    return res.json({ data: withOrderPublicId(order), refund });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    if (message === 'ORDER_NOT_FOUND') {
      return res.status(404).json({ error: { code: message } });
    }
    if (
      message === 'ORDER_NOT_PAID' ||
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
        financials: financialsForBuyer(order),
        deliveryStatusLabel,
        deliveryEta
      }
    });
  } catch (error) {
    return next(error);
  }
});
