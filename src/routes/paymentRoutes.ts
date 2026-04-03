import { Router } from 'express';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
import { prisma } from '../lib/prisma';
import { paymentFlowService } from '../services/paymentFlowService';

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
        quantity: z.number().int().min(1)
      })
    )
    .min(1)
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
      prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
      prismaMeta: error instanceof Prisma.PrismaClientKnownRequestError ? error.meta : undefined
    });
    return next(error);
  }
});

paymentRoutes.post('/yookassa/webhook', async (req, res, next) => {
  try {
    const payload = yookassaWebhookSchema.parse(req.body);

    console.info('[YOOKASSA][WEBHOOK]', {
      event: payload.event,
      objectId: payload.object.id,
      paymentId: payload.object.payment_id ?? payload.object.id,
      dealId: payload.object.metadata?.dealId ?? payload.object.deal?.id ?? null,
      orderId: payload.object.metadata?.orderId ?? null,
      amount: payload.object.amount?.value ?? null,
      status: payload.object.status ?? null
    });

    if (payload.event === 'refund.succeeded') {
      await paymentFlowService.processRefundWebhook({
        externalRefundId: payload.object.id,
        amount: payload.object.amount?.value ?? '0',
        orderId: payload.object.metadata?.orderId,
        payload
      });
      return res.json({ received: true });
    }

    if (payload.event.startsWith('deal.') || payload.event.startsWith('payout.')) {
      console.info('[YOOKASSA][DEAL_WEBHOOK]', {
        event: payload.event,
        dealId: payload.object.metadata?.dealId ?? null,
        orderId: payload.object.metadata?.orderId ?? null,
        payoutId: payload.object.id,
        status: payload.object.status ?? null
      });
      return res.json({ received: true });
    }

    if (payload.event === 'payment.succeeded' || payload.event === 'payment.canceled') {
      const orderId = payload.object.metadata?.orderId;
      if (!orderId) {
        throw new Error('ORDER_ID_MISSING');
      }

      await paymentFlowService.processWebhook({
        externalId: payload.object.id,
        status: payload.object.status === 'succeeded' ? 'succeeded' : 'canceled',
        orderId,
        amount: payload.object.amount?.value ?? '0',
        dealId: payload.object.metadata?.dealId ?? payload.object.deal?.id,
        provider: 'yookassa',
        payload
      });

      if (payload.event === 'payment.succeeded') {
        const resolvedDealId = payload.object.metadata?.dealId ?? payload.object.deal?.id ?? null;
        if (resolvedDealId) {
          await prisma.order.updateMany({
            where: { id: orderId, yookassaDealId: null },
            data: {
              yookassaDealId: resolvedDealId
            }
          });
        }
      }
    }

    return res.json({ received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'UNKNOWN_ERROR';
    console.error('[YOOKASSA][WEBHOOK_ERROR]', {
      message,
      error
    });
    return res.status(200).json({ received: true });
  }
});
