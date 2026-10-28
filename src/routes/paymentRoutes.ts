import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { paymentFlowService } from '../services/paymentFlowService';
import { yookassaWebhookService } from '../services/yookassaWebhookService';
import { quoteCheckoutShipping } from '../services/checkoutShippingService';
import { ShippingQuoteError } from '../services/shippingPackageService';

export const paymentRoutes = Router();

const startSchema = z.object({
  paymentAttemptKey: z.string().min(6),
  recipient: z.object({
    name: z.string().trim().min(1),
    phone: z.string().trim().min(1),
    email: z.string().email().optional().nullable()
  }),
  packagesCount: z.number().int().min(1).default(1),
  buyerPickupPvz: z.object({
    provider: z.string().optional(),
    pvzId: z.string().min(1),
    buyerPickupPlatformStationId: z.string().regex(/^\d+$/).optional(),
    buyerPickupOperatorStationId: z.string().regex(/^\d+$/).optional(),
    addressFull: z.string().optional(),
    raw: z.unknown().optional()
  }),
  items: z
    .array(
      z.object({
        productId: z.string(),
        variantId: z.string().optional(),
        quantity: z.number().int().min(1),
        expectedPriceKopecks: z.number().int().nonnegative().optional()
      })
    )
    .min(1)
});

const quoteSchema = startSchema.pick({ buyerPickupPvz: true, items: true });

paymentRoutes.post('/quote', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = quoteSchema.parse(req.body);
    const result = await quoteCheckoutShipping(payload.items, payload.buyerPickupPvz);
    return res.json({ data: {
      deliveryAmountKopecks: result.deliveryAmountKopecks,
      shippingSnapshot: result.snapshot
    } });
  } catch (error) {
    if (error instanceof ShippingQuoteError ||
        ['SELLER_DROPOFF_PVZ_REQUIRED', 'PRODUCT_NOT_FOUND', 'MULTI_SELLER_CHECKOUT_NOT_SUPPORTED'].includes((error as Error).message)) {
      const code = error instanceof ShippingQuoteError ? error.code : (error as Error).message;
      return res.status(400).json({ error: { code, message: code } });
    }
    next(error);
  }
});

const yookassaWebhookSchema = z.object({
  event: z.string(),
  object: z.object({
    id: z.string(),
    status: z.string().optional(),
    deal: z.object({ id: z.string().optional() }).optional(),
    amount: z.object({
      value: z.string()
    }).optional(),
    payment_id: z.string().optional(),
    metadata: z
      .object({
        orderId: z.string().optional(),
        dealId: z.string().optional()
      })
      .optional()
  })
});

paymentRoutes.post('/start', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    const payload = startSchema.parse(req.body);
    const data = await paymentFlowService.startPayment({
      buyerId: req.user!.userId,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const mappedStatus =
      message === 'PRODUCT_NOT_FOUND' ||
      message === 'MULTI_SELLER_CHECKOUT_NOT_SUPPORTED' ||
      message === 'SELLER_DROPOFF_PVZ_REQUIRED'
      || message === 'SHIPPING_QUOTE_FAILED'
      || error instanceof ShippingQuoteError
        ? 400
        : message === 'PRODUCT_PRICE_CHANGED'
        ? 409
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
      prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
      prismaMeta: error instanceof Prisma.PrismaClientKnownRequestError ? error.meta : undefined
    });
    return next(error);
  }
});

paymentRoutes.post('/yookassa/webhook', async (req, res) => {
  const parsed = yookassaWebhookSchema.safeParse(req.body);
  if (!parsed.success) return res.json({ received: true });
  const payload = parsed.data;
  try {
    let result: { reason: string; orderId?: string };
    if (payload.event === 'refund.succeeded') {
      result = await yookassaWebhookService.handleRefundSignal({
        externalId: payload.object.id, bodyOrderId: payload.object.metadata?.orderId
      });
    } else if (payload.event === 'payment.succeeded' || payload.event === 'payment.canceled') {
      result = await yookassaWebhookService.handlePaymentSignal(payload.event, {
        externalId: payload.object.id, bodyOrderId: payload.object.metadata?.orderId
      });
    } else {
      return res.json({ received: true });
    }

    console.info('[YOOKASSA][WEBHOOK]', {
      event: payload.event, externalId: payload.object.id,
      verification: result.reason, orderId: result.orderId ?? null
    });

    return res.json({ received: true });
  } catch (error) {
    console.error('[YOOKASSA][WEBHOOK_ERROR]', {
      event: payload.event, externalId: payload.object.id,
      verification: 'RETRYABLE_ERROR',
      reason: error instanceof Error && error.message === 'YOOKASSA_VERIFICATION_UNAVAILABLE'
        ? 'PROVIDER_UNAVAILABLE'
        : 'PROCESSING_ERROR'
    });
    return res.status(503).json({ received: false, error: { code: 'WEBHOOK_RETRY' } });
  }
});
