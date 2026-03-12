import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { prisma } from '../lib/prisma';
import { orderUseCases } from '../usecases/orderUseCases';

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
      where: { id: { in: uniqueProductIds } },
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
      const raw = (sellerSettings.defaultDropoffPvzMeta as Record<string, unknown> | null)?.raw;
      const cityCode = raw && typeof raw === 'object' ? Number((raw as Record<string, unknown>).city_code ?? 0) : 0;
      if (!Number.isFinite(cityCode) || cityCode <= 0) {
        return res.status(400).json({
          error: {
            code: 'CITY_CODE_MISSING',
            message: 'seller CDEK dropoff PVZ meta must contain raw.city_code',
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
        : undefined
    });

    return res.status(201).json({ data: order, orderId: order.id });
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
    return res.json({ data: updated });
  } catch (error) {
    return next(error);
  }
});


orderRoutes.post('/:id/cancel', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const order = await prisma.order.findFirst({
      where: { id: req.params.id, buyerId: req.user!.userId },
      include: { shipment: true }
    });
    if (!order) return res.status(404).json({ error: { code: 'ORDER_NOT_FOUND' } });

    if (order.status === 'CANCELLED') {
      return res.json({ data: order });
    }

    const handoverStarted = Boolean(order.readyForShipmentAt) || Boolean(order.shipment);
    if (handoverStarted) {
      return res.status(409).json({
        error: {
          code: 'CANNOT_CANCEL_AFTER_HANDOVER',
          message: 'Заказ уже передан в доставку. Оформите возврат через кабинет.'
        }
      });
    }

    const updated = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED', statusUpdatedAt: new Date() }
    });

    return res.json({ data: updated });
  } catch (error) {
    return next(error);
  }
});

orderRoutes.get('/me', authenticate, async (req: AuthRequest, res, next) => {
  try {
    const orders = await prisma.order.findMany({
      where: { buyerId: req.user!.userId },
      include: { items: { include: { product: true, variant: true } }, shipment: true, deliveryEvents: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ data: orders });
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
    const order = await prisma.order.findFirst({
      where: {
        id: req.params.id,
        OR: [{ buyerId: req.user!.userId }, { items: { some: { product: { sellerId: req.user!.userId } } } }]
      },
      include: {
        items: { include: { product: true, variant: true } },
        contact: true,
        shippingAddress: true,
        buyer: true,
        deliveryEvents: { orderBy: { createdAt: 'desc' } }
      }
    });
    if (!order) {
      return res.status(404).json({ error: { code: 'NOT_FOUND' } });
    }
    return res.json({ data: order });
  } catch (error) {
    return next(error);
  }
});
