import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/authMiddleware';
import { writeLimiter } from '../middleware/rateLimiters';
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
  event: z.enum(['payment.succeeded', 'payment.canceled']),
  object: z.object({
    id: z.string(),
    status: z.string().optional()
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
    return next(error);
  }
});

paymentRoutes.post('/yookassa/webhook', async (req, res, next) => {
  try {
    const payload = yookassaWebhookSchema.parse(req.body);
    const mappedStatus = payload.event === 'payment.succeeded' ? 'success' : 'cancelled';

    console.info('[YOOKASSA][webhook]', {
      event: payload.event,
      paymentId: payload.object.id,
      status: payload.object.status ?? null
    });

    await paymentFlowService.processWebhook({
      externalId: payload.object.id,
      status: mappedStatus,
      provider: 'yookassa',
      payload
    });

    return res.json({ received: true });
  } catch (error) {
    return next(error);
  }
});
