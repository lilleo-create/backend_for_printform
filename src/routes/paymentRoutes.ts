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

const webhookSchema = z.object({
  paymentId: z.string(),
  status: z.enum(['success', 'failed', 'cancelled', 'expired']),
  provider: z.string().optional()
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


paymentRoutes.post('/:id/mock-success', authenticate, writeLimiter, async (req: AuthRequest, res, next) => {
  try {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('FORBIDDEN');
    }

    await paymentFlowService.mockSuccess(req.params.id, req.user!.userId);
    return res.json({ data: { ok: true } });
  } catch (error) {
    return next(error);
  }
});

paymentRoutes.post('/webhook', async (req, res, next) => {
  try {
    const signature = req.headers['x-signature'];
    if (!signature) {
      return res.status(400).json({ error: { code: 'SIGNATURE_REQUIRED' } });
    }

    const payload = webhookSchema.parse(req.body);
    await paymentFlowService.processWebhook(payload);

    return res.json({ received: true });
  } catch (error) {
    return next(error);
  }
});
