import { Prisma, PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { orderUseCases } from '../usecases/orderUseCases';
import { expirePendingPayments, nextPaymentExpiryDate } from '../utils/orderPayment';

type StartPaymentInput = {
  buyerId: string;
  paymentAttemptKey: string;
  recipient: {
    name: string;
    phone: string;
    email?: string | null;
  };
  packagesCount?: number;
  items: { productId: string; variantId?: string; quantity: number }[];
  buyerPickupPvz: {
    provider?: 'CDEK';
    pvzId: string;
    buyerPickupPlatformStationId?: string;
    buyerPickupOperatorStationId?: string;
    addressFull?: string;
    raw?: unknown;
  };
};

const buildPaymentUrl = (paymentId: string) => `https://payment.local/checkout/${paymentId}`;

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
};

const normalizeUuid = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed) ? trimmed : null;
};

const normalizeDigits = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^\d+$/.test(trimmed) ? trimmed : null;
};

const normalizeBuyerPickupPvz = (input: StartPaymentInput['buyerPickupPvz']) => {
  const raw = asRecord(input.raw) ?? {};

  const buyerPickupPlatformStationId =
    normalizeUuid(input.buyerPickupPlatformStationId) ??
    normalizeUuid(raw.buyerPickupPlatformStationId) ??
    normalizeUuid(raw.platform_station_id) ??
    null;

  const buyerPickupOperatorStationId =
    normalizeDigits(input.buyerPickupOperatorStationId) ??
    normalizeDigits(raw.buyerPickupOperatorStationId) ??
    normalizeDigits(raw.operator_station_id) ??
    null;

  const normalizedRaw = {
    ...raw,
    id: input.pvzId,
    type: 'PVZ',
    buyerPickupPointId: input.pvzId,
    buyerPickupPlatformStationId,
    buyerPickupOperatorStationId,
    addressFull: input.addressFull ?? (typeof raw.addressFull === 'string' ? raw.addressFull : undefined),
    fullAddress: input.addressFull ?? (typeof raw.fullAddress === 'string' ? raw.fullAddress : undefined)
  };

  return {
    ...input,
    provider: 'CDEK' as const,
    buyerPickupPlatformStationId: buyerPickupPlatformStationId ?? undefined,
    buyerPickupOperatorStationId: buyerPickupOperatorStationId ?? undefined,
    raw: normalizedRaw
  };
};

const buildOrderLabels = (orderId: string, packagesCount: number) => {
  const shortId = orderId.replace(/[^a-zA-Z0-9]/g, '').slice(-7).toUpperCase();
  return Array.from({ length: packagesCount }, (_, index) => {
    const packageNo = index + 1;
    const base = `PF-${shortId}-${packageNo}`;
    return { packageNo, code: base.slice(0, 15) };
  });
};

export const paymentFlowService = {
  async startPayment(input: StartPaymentInput) {
    await expirePendingPayments();
    const existingOrder = await prisma.order.findFirst({
      where: { buyerId: input.buyerId, paymentAttemptKey: input.paymentAttemptKey }
    });

    let order = existingOrder;
    const deliveryConfigMissing = false;
    const blockingReason: null = null;

    if (!order) {
      const productIds = input.items.map((item) => item.productId);
      const uniqueProductIds = Array.from(new Set(productIds));
      const products = await prisma.product.findMany({
        where: { id: { in: uniqueProductIds }, deletedAt: null, moderationStatus: 'APPROVED' },
        select: { id: true, sellerId: true }
      });

      if (products.length !== uniqueProductIds.length) {
        throw new Error('PRODUCT_NOT_FOUND');
      }

      const sellerIds = Array.from(new Set(products.map((product) => product.sellerId)));
      if (sellerIds.length !== 1) {
        throw new Error('MULTI_SELLER_CHECKOUT_NOT_SUPPORTED');
      }

      const sellerSettings = await prisma.sellerSettings.findUnique({ where: { sellerId: sellerIds[0] } });

      try {
        const normalizedBuyerPickupPvz = normalizeBuyerPickupPvz(input.buyerPickupPvz);

        const createdOrder = await orderUseCases.create({
          buyerId: input.buyerId,
          paymentAttemptKey: input.paymentAttemptKey,
          buyerPickupPvz: normalizedBuyerPickupPvz,
          sellerDropoffPvz: sellerSettings?.defaultDropoffPvzId
            ? {
                provider: 'CDEK',
                pvzId: sellerSettings.defaultDropoffPvzId,
                raw: sellerSettings.defaultDropoffPvzMeta ?? {},
                addressFull:
                  typeof sellerSettings.defaultDropoffPvzMeta === 'object' && sellerSettings.defaultDropoffPvzMeta
                    ? String((sellerSettings.defaultDropoffPvzMeta as Record<string, unknown>).addressFull ?? '')
                    : undefined
              }
            : undefined,
          recipient: {
            name: input.recipient.name,
            phone: input.recipient.phone,
            email: input.recipient.email ?? null
          },
          packagesCount: input.packagesCount ?? 1,
          orderLabels: [],
          items: input.items
        });

        order = createdOrder;

        const labels = buildOrderLabels(createdOrder.id, createdOrder.packagesCount ?? input.packagesCount ?? 1);
        order = await prisma.order.update({ where: { id: createdOrder.id }, data: { orderLabels: labels } });
      } catch (error) {
        const isUniqueViolation =
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002' &&
          Array.isArray(error.meta?.target) &&
          (error.meta?.target as string[]).includes('buyerId') &&
          (error.meta?.target as string[]).includes('paymentAttemptKey');

        if (!isUniqueViolation) throw error;

        order = await prisma.order.findFirst({
          where: { buyerId: input.buyerId, paymentAttemptKey: input.paymentAttemptKey }
        });
      }
    }

    if (!order) throw new Error('ORDER_CREATE_FAILED');

    const normalizedBuyerPickupPvz = normalizeBuyerPickupPvz(input.buyerPickupPvz);
    console.info('[PAYMENT][buyer_pvz]', {
      buyerId: input.buyerId,
      provider: normalizedBuyerPickupPvz.provider,
      buyerPickupPvzId: input.buyerPickupPvz.pvzId,
      buyerPickupPlatformStationId: normalizedBuyerPickupPvz.buyerPickupPlatformStationId ?? null,
      buyerPickupOperatorStationId: normalizedBuyerPickupPvz.buyerPickupOperatorStationId ?? null,
      addressFull: input.buyerPickupPvz.addressFull ?? null
    });

    const shouldRefreshLabels = !order.orderLabels || !Array.isArray(order.orderLabels) || order.orderLabels.length === 0;
    const shouldUpdateRecipient = !order.recipientName || !order.recipientPhone;

    if (shouldRefreshLabels || shouldUpdateRecipient) {
      const labels = shouldRefreshLabels ? buildOrderLabels(order.id, order.packagesCount ?? input.packagesCount ?? 1) : order.orderLabels;
      order = await prisma.order.update({
        where: { id: order.id },
        data: {
          orderLabels: labels as Prisma.InputJsonValue,
          recipientName: shouldUpdateRecipient ? input.recipient.name : order.recipientName,
          recipientPhone: shouldUpdateRecipient ? input.recipient.phone : order.recipientPhone,
          recipientEmail: shouldUpdateRecipient ? input.recipient.email ?? null : order.recipientEmail
        }
      });
    }

    const existingPayment = await prisma.payment.findFirst({ where: { orderId: order.id }, orderBy: { createdAt: 'desc' } });
    if (existingPayment) {
      const paymentUrl = String((existingPayment.payloadJson as Record<string, unknown> | null)?.paymentUrl ?? buildPaymentUrl(existingPayment.id));
      return {
        orderId: order.id,
        paymentId: existingPayment.id,
        paymentUrl,
        paymentStatus: order.paymentStatus,
        paymentExpiresAt: order.paymentExpiresAt,
        deliveryConfigMissing,
        blockingReason
      };
    }

    return prisma.$transaction(async (tx) => {
      const lockedOrder = await tx.order.findUnique({ where: { id: order.id } });
      if (!lockedOrder) throw new Error('ORDER_NOT_FOUND');

      if (lockedOrder.paymentId) {
        const lockedPayment = await tx.payment.findUnique({ where: { id: lockedOrder.paymentId } });
        if (lockedPayment) {
          const paymentUrl = String((lockedPayment.payloadJson as Record<string, unknown> | null)?.paymentUrl ?? buildPaymentUrl(lockedPayment.id));
          return {
            orderId: lockedOrder.id,
            paymentId: lockedPayment.id,
            paymentUrl,
            paymentStatus: lockedOrder.paymentStatus,
            paymentExpiresAt: lockedOrder.paymentExpiresAt,
            deliveryConfigMissing,
            blockingReason
          };
        }
      }

      const payment = await tx.payment.create({
        data: {
          orderId: lockedOrder.id,
          provider: 'manual',
          status: 'PENDING',
          amount: lockedOrder.total,
          currency: lockedOrder.currency,
          payloadJson: { paymentUrl: '' }
        }
      });

      const paymentUrl = buildPaymentUrl(payment.id);
      await tx.payment.update({ where: { id: payment.id }, data: { payloadJson: { paymentUrl } } });

      const claimed = await tx.order.updateMany({
        where: { id: lockedOrder.id, paymentId: null },
        data: {
          paymentId: payment.id,
          paymentProvider: payment.provider,
          paymentStatus: 'PENDING_PAYMENT',
          paymentExpiresAt: nextPaymentExpiryDate(),
          expiredAt: null
        }
      });

      if (claimed.count === 0) {
        await tx.payment.delete({ where: { id: payment.id } });
        const existing = await tx.order.findUnique({ where: { id: lockedOrder.id } });
        if (existing?.paymentId) {
          const existingPayment2 = await tx.payment.findUnique({ where: { id: existing.paymentId } });
          if (existingPayment2) {
            const url = String((existingPayment2.payloadJson as Record<string, unknown> | null)?.paymentUrl ?? buildPaymentUrl(existingPayment2.id));
            return {
              orderId: existing.id,
              paymentId: existingPayment2.id,
              paymentUrl: url,
              paymentStatus: existing.paymentStatus,
              paymentExpiresAt: existing.paymentExpiresAt,
              deliveryConfigMissing,
              blockingReason
            };
          }
        }
      }

      return {
        orderId: lockedOrder.id,
        paymentId: payment.id,
        paymentUrl,
        paymentStatus: 'PENDING_PAYMENT' as const,
        paymentExpiresAt: nextPaymentExpiryDate(),
        deliveryConfigMissing,
        blockingReason
      };
    });
  },

  async retryPayment(orderId: string, buyerId: string) {
    await expirePendingPayments();
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: orderId, buyerId } });
      if (!order) throw new Error('ORDER_NOT_FOUND');
      if (order.paidAt || order.paymentStatus === 'PAID') throw new Error('ORDER_ALREADY_PAID');
      if (order.paymentStatus !== 'PAYMENT_EXPIRED') throw new Error('PAYMENT_RETRY_FORBIDDEN');

      const payment = await tx.payment.create({
        data: {
          orderId: order.id,
          provider: order.paymentProvider ?? 'manual',
          status: 'PENDING',
          amount: order.total,
          currency: order.currency,
          payloadJson: { paymentUrl: '' }
        }
      });
      const paymentUrl = buildPaymentUrl(payment.id);
      const paymentExpiresAt = nextPaymentExpiryDate();
      await tx.payment.update({ where: { id: payment.id }, data: { payloadJson: { paymentUrl } } });
      await tx.order.update({
        where: { id: order.id },
        data: {
          paymentStatus: 'PENDING_PAYMENT',
          paymentExpiresAt,
          expiredAt: null,
          paymentId: payment.id,
          status: 'CREATED',
          statusUpdatedAt: new Date()
        }
      });

      return { orderId: order.id, paymentStatus: 'PENDING_PAYMENT' as const, paymentExpiresAt, paymentUrl };
    });
  },

  async mockSuccess(paymentId: string, buyerId: string) {
    const payment = await prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: { select: { buyerId: true } } }
    });

    if (!payment) return { ok: true };
    if (payment.order.buyerId !== buyerId) throw new Error('FORBIDDEN');

    return this.processWebhook({ paymentId, status: 'success', provider: 'manual' });
  },

  async processWebhook(input: { paymentId: string; status: 'success' | 'failed' | 'cancelled' | 'expired'; provider?: string }) {
    const payment = await prisma.payment.findUnique({ where: { id: input.paymentId }, include: { order: true } });
    if (!payment) return { ok: true };

    if (input.status === 'success') {
      await prisma.$transaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id: payment.orderId } });
        if (!order) return;

        if (order.status === 'PAID') {
          await tx.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED' } });
          return;
        }

        await tx.payment.update({ where: { id: payment.id }, data: { status: 'SUCCEEDED' } });

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: 'PAID',
            paymentStatus: 'PAID',
            paymentExpiresAt: null,
            paidAt: new Date(),
            paymentProvider: input.provider ?? payment.provider,
            paymentId: payment.id,
            payoutStatus: 'HOLD'
          }
        });
      });

      return { ok: true };
    }

    const paymentStatus: PaymentStatus = 'FAILED';

    await prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id: payment.orderId } });
      if (!order) return;
      await tx.payment.update({ where: { id: payment.id }, data: { status: paymentStatus } });
      if (order.status === 'PAID') return;
      await tx.order.update({
        where: { id: order.id },
        data: {
          status: input.status === 'expired' ? 'EXPIRED' : 'CREATED',
          paymentStatus: input.status === 'expired' ? 'PAYMENT_EXPIRED' : 'CANCELLED',
          expiredAt: input.status === 'expired' ? new Date() : order.expiredAt
        }
      });
    });

    return { ok: true };
  }
};
