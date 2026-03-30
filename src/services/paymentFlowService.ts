import { Prisma, PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { orderUseCases } from '../usecases/orderUseCases';
import { expirePendingPayments, nextPaymentExpiryDate } from '../utils/orderPayment';
import { yookassaService } from './yookassaService';

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
    try {
      await expirePendingPayments();
      console.info('[PAYMENT][START]', {
        buyerId: input.buyerId,
        paymentAttemptKey: input.paymentAttemptKey
      });
      const existingOrder = await prisma.order.findFirst({
        where: { buyerId: input.buyerId, paymentAttemptKey: input.paymentAttemptKey }
      });

      let order = existingOrder;
      const deliveryConfigMissing = false;
      const blockingReason: null = null;

      if (!order) {
        const productIds = input.items.map((item) => item.productId);
        const uniqueProductIds = Array.from(new Set(productIds));
        console.info('[PAYMENT][PRODUCT_IDS]', {
          buyerId: input.buyerId,
          paymentAttemptKey: input.paymentAttemptKey,
          productIds,
          uniqueProductIds
        });

        const products = await prisma.product.findMany({
          where: { id: { in: uniqueProductIds }, deletedAt: null, moderationStatus: 'APPROVED' },
          select: { id: true, sellerId: true }
        });

        console.info('[PAYMENT][PRODUCTS_FOUND]', {
          buyerId: input.buyerId,
          paymentAttemptKey: input.paymentAttemptKey,
          products
        });

        if (products.length !== uniqueProductIds.length) {
          console.error('[PAYMENT][PRODUCTS_FOUND][MISMATCH]', {
            buyerId: input.buyerId,
            paymentAttemptKey: input.paymentAttemptKey,
            requestedProductIds: uniqueProductIds,
            foundProductIds: products.map((product) => product.id)
          });
          throw new Error('PRODUCT_NOT_FOUND');
        }

        const sellerIds = Array.from(new Set(products.map((product) => product.sellerId)));
        if (sellerIds.length !== 1) {
          throw new Error('MULTI_SELLER_CHECKOUT_NOT_SUPPORTED');
        }

        const sellerSettings = await prisma.sellerSettings.findUnique({ where: { sellerId: sellerIds[0] } });
        console.info('[PAYMENT][SELLER_SETTINGS]', {
          buyerId: input.buyerId,
          paymentAttemptKey: input.paymentAttemptKey,
          sellerIds,
          sellerSettingsPresent: Boolean(sellerSettings),
          defaultDropoffPvzIdPresent: Boolean(sellerSettings?.defaultDropoffPvzId),
          defaultDropoffPvzMetaPresent: Boolean(sellerSettings?.defaultDropoffPvzMeta)
        });

        try {
          const normalizedBuyerPickupPvz = normalizeBuyerPickupPvz(input.buyerPickupPvz);
          const orderCreateInput = {
            buyerId: input.buyerId,
            paymentAttemptKey: input.paymentAttemptKey,
            buyerPickupPvz: normalizedBuyerPickupPvz,
            sellerDropoffPvz: sellerSettings?.defaultDropoffPvzId
              ? {
                  provider: 'CDEK' as const,
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
          };

          console.info('[PAYMENT][ORDER_CREATE_INPUT]', {
            buyerId: input.buyerId,
            paymentAttemptKey: input.paymentAttemptKey,
            normalizedBuyerPickupPvz: orderCreateInput.buyerPickupPvz,
            sellerDropoffPvz: orderCreateInput.sellerDropoffPvz,
            items: orderCreateInput.items
          });

          const createdOrder = await orderUseCases.create(orderCreateInput);
          console.info('[PAYMENT][ORDER_CREATE_INPUT][CREATED]', {
            buyerId: input.buyerId,
            paymentAttemptKey: input.paymentAttemptKey,
            orderId: createdOrder.id
          });

          order = createdOrder;

          const labels = buildOrderLabels(createdOrder.id, createdOrder.packagesCount ?? input.packagesCount ?? 1);
          order = await prisma.order.update({ where: { id: createdOrder.id }, data: { orderLabels: labels } });
        } catch (error) {
          console.error('[PAYMENT][ORDER_CREATE_ERROR]', {
            buyerId: input.buyerId,
            paymentAttemptKey: input.paymentAttemptKey,
            error,
            stack: error instanceof Error ? error.stack : undefined,
            prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
            prismaMeta: error instanceof Prisma.PrismaClientKnownRequestError ? error.meta : undefined
          });

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
      console.info('[PAYMENT][START]', {
        buyerId: input.buyerId,
        paymentAttemptKey: input.paymentAttemptKey,
        orderId: order.id,
        normalizedBuyerPickupPvz
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
        const paymentUrl = String((existingPayment.payloadJson as Record<string, unknown> | null)?.paymentUrl ?? '');
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
          const paymentUrl = String((lockedPayment.payloadJson as Record<string, unknown> | null)?.paymentUrl ?? '');
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

        console.info('[PAYMENT][YOOKASSA_CREATE_INPUT]', {
          buyerId: input.buyerId,
          paymentAttemptKey: input.paymentAttemptKey,
          orderId: lockedOrder.id,
          amount: lockedOrder.total,
          currency: lockedOrder.currency
        });
        const yookassaPayment = await yookassaService.createPayment({
          amount: lockedOrder.total,
          currency: lockedOrder.currency,
          orderId: lockedOrder.id,
          description: `Оплата заказа ${lockedOrder.id}`
        });

        const payment = await tx.payment.create({
          data: {
            orderId: lockedOrder.id,
            provider: 'yookassa',
            externalId: yookassaPayment.id,
            status: 'PENDING',
            amount: lockedOrder.total,
            currency: lockedOrder.currency,
            payloadJson: yookassaPayment.payload as Prisma.InputJsonValue
          }
        });
        const paymentUrl = yookassaPayment.confirmationUrl;

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
              const url = String((existingPayment2.payloadJson as Record<string, unknown> | null)?.paymentUrl ?? '');
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
    } catch (error) {
      console.error('[PAYMENT][ERROR]', {
        buyerId: input.buyerId,
        paymentAttemptKey: input.paymentAttemptKey,
        error,
        stack: error instanceof Error ? error.stack : undefined,
        prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
        prismaMeta: error instanceof Prisma.PrismaClientKnownRequestError ? error.meta : undefined
      });
      throw error;
    }
  },

  async retryPayment(orderId: string, buyerId: string) {
    await expirePendingPayments();
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({ where: { id: orderId, buyerId } });
      if (!order) throw new Error('ORDER_NOT_FOUND');
      if (order.paidAt || order.paymentStatus === 'PAID') throw new Error('ORDER_ALREADY_PAID');
      if (order.paymentStatus !== 'PAYMENT_EXPIRED') throw new Error('PAYMENT_RETRY_FORBIDDEN');

      const payment = await tx.payment.create({
        // TODO: migrate to YooKassa Safe Deal (escrow)
        // TODO: add seller payouts via YooKassa
        // TODO: integrate OAuth seller accounts
        data: {
          orderId: order.id,
          provider: 'yookassa',
          status: 'PENDING',
          amount: order.total,
          currency: order.currency,
          payloadJson: {}
        }
      });

      const yookassaPayment = await yookassaService.createPayment({
        amount: order.total,
        currency: order.currency,
        orderId: order.id,
        description: `Оплата заказа ${order.id}`
      });

      const paymentUrl = yookassaPayment.confirmationUrl;
      const paymentExpiresAt = nextPaymentExpiryDate();
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          externalId: yookassaPayment.id,
          payloadJson: yookassaPayment.payload as Prisma.InputJsonValue
        }
      });
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

  async processWebhook(input: {
    externalId: string;
    status: 'succeeded' | 'canceled';
    orderId: string;
    amount: string;
    provider?: string;
    payload?: unknown;
  }) {
    const order = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order) return { ok: true };

    const paymentAmount = Number(input.amount);
    const orderAmount = order.total / 100;
    if (paymentAmount !== orderAmount) {
      console.error('[YOOKASSA][AMOUNT_MISMATCH]', {
        externalId: input.externalId,
        orderId: input.orderId,
        paymentAmount,
        orderAmount
      });
      throw new Error('PAYMENT_AMOUNT_MISMATCH');
    }

    const payment = await prisma.payment.findFirst({ where: { externalId: input.externalId }, include: { order: true } });
    if (!payment) return { ok: true };

    if (payment.status === 'SUCCEEDED' || payment.status === 'CANCELED') {
      return { ok: true };
    }

    if (input.status === 'succeeded') {
      const updateResult = await prisma.payment.updateMany({
        where: {
          externalId: input.externalId,
          status: { not: 'SUCCEEDED' }
        },
        data: { status: 'SUCCEEDED' }
      });

      if (updateResult.count === 0) return { ok: true };

      await prisma.order.update({
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

      return { ok: true };
    }

    const updateResult = await prisma.payment.updateMany({
      where: {
        externalId: input.externalId,
        status: { notIn: ['SUCCEEDED', 'CANCELED'] }
      },
      data: { status: 'CANCELED' as PaymentStatus }
    });
    if (updateResult.count === 0) return { ok: true };

    await prisma.order.update({
      where: { id: order.id },
      data: {
        paymentStatus: 'PAYMENT_EXPIRED'
      }
    });

    return { ok: true };
  }
};
