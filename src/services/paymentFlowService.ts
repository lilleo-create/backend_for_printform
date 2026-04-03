import { Prisma, PaymentStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { orderUseCases } from '../usecases/orderUseCases';
import { expirePendingPayments, nextPaymentExpiryDate } from '../utils/orderPayment';
import { money, rublesToKopecks } from '../utils/money';
import { env } from '../config/env';
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

const extractDealIdFromPayload = (payload: unknown): string | null => {
  const root = asRecord(payload);
  const object = asRecord(root?.object);
  const metadata = asRecord(object?.metadata);
  const deal = asRecord(object?.deal);
  const rootMetadata = asRecord(root?.metadata);
  const rootDeal = asRecord(root?.deal);
  const directDealId =
    (typeof root?.dealId === 'string' ? root.dealId.trim() : '') ||
    (typeof root?.yookassaDealId === 'string' ? root.yookassaDealId.trim() : '');
  if (directDealId) return directDealId;
  const rootMetadataDealId = typeof rootMetadata?.dealId === 'string' ? rootMetadata.dealId.trim() : '';
  if (rootMetadataDealId) return rootMetadataDealId;
  const rootDealId = typeof rootDeal?.id === 'string' ? rootDeal.id.trim() : '';
  if (rootDealId) return rootDealId;
  const metadataDealId = typeof metadata?.dealId === 'string' ? metadata.dealId.trim() : '';
  if (metadataDealId) return metadataDealId;
  const dealId = typeof deal?.id === 'string' ? deal.id.trim() : '';
  if (dealId) return dealId;
  return null;
};

const mergePaymentPayloadWithWebhook = (existingPayload: unknown, webhookPayload: unknown, resolvedDealId: string | null) => {
  const existing = asRecord(existingPayload) ?? {};
  const webhook = asRecord(webhookPayload) ?? {};
  const existingMetadata = asRecord(existing.metadata) ?? {};
  const webhookObject = asRecord(webhook.object);
  const webhookMetadata = asRecord(webhookObject?.metadata) ?? {};

  return {
    ...existing,
    ...webhook,
    metadata: {
      ...existingMetadata,
      ...webhookMetadata,
      ...(resolvedDealId ? { dealId: resolvedDealId } : {})
    },
    ...(resolvedDealId ? { dealId: resolvedDealId, yookassaDealId: resolvedDealId } : {})
  } as Prisma.InputJsonValue;
};

const buildOrderLabels = (orderId: string, packagesCount: number) => {
  const shortId = orderId.replace(/[^a-zA-Z0-9]/g, '').slice(-7).toUpperCase();
  return Array.from({ length: packagesCount }, (_, index) => {
    const packageNo = index + 1;
    const base = `PF-${shortId}-${packageNo}`;
    return { packageNo, code: base.slice(0, 15) };
  });
};

const isFullRefund = (paidAmount: number, refundedAmount: number) => refundedAmount >= paidAmount;

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
          amountKopecks: lockedOrder.total,
          currency: lockedOrder.currency,
          safeDealEnabled: env.yookassaSafeDealEnabled
        });

        let yookassaPayment;
        let safeDealId = lockedOrder.yookassaDealId;

        if (env.yookassaSafeDealEnabled) {
          if (!safeDealId) {
            const deal = await yookassaService.createDeal({
              orderId: lockedOrder.id,
              currency: lockedOrder.currency,
              platformFeeAmountKopecks: lockedOrder.platformFeeKopecks ?? undefined
            });
            safeDealId = deal.id;
            await tx.order.update({
              where: { id: lockedOrder.id },
              data: {
                yookassaDealId: deal.id,
                yookassaDealStatus: deal.status,
                sellerNetAmountKopecks:
                  lockedOrder.sellerNetAmountKopecks ??
                  Math.max(0, lockedOrder.total - ((lockedOrder.platformFeeKopecks ?? 0) + (lockedOrder.acquiringFeeKopecks ?? 0)))
              }
            });
          }

          const returnUrl = new URL(env.yookassaReturnUrl);
          returnUrl.searchParams.set('orderId', lockedOrder.id);

          yookassaPayment = await yookassaService.createPaymentInDeal({
            orderId: lockedOrder.id,
            dealId: safeDealId,
            amountKopecks: lockedOrder.total,
            currency: lockedOrder.currency,
            returnUrl: returnUrl.toString(),
            description: `Оплата заказа ${lockedOrder.id}`
          });
        } else {
          yookassaPayment = await yookassaService.createPayment({
            amount: lockedOrder.total,
            currency: lockedOrder.currency,
            orderId: lockedOrder.id,
            description: `Оплата заказа ${lockedOrder.id}`
          });
        }

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

      let yookassaPayment;
      if (env.yookassaSafeDealEnabled && order.yookassaDealId) {
        const returnUrl = new URL(env.yookassaReturnUrl);
        returnUrl.searchParams.set('orderId', order.id);
        yookassaPayment = await yookassaService.createPaymentInDeal({
          orderId: order.id,
          dealId: order.yookassaDealId,
          amountKopecks: order.total,
          currency: order.currency,
          returnUrl: returnUrl.toString(),
          description: `Оплата заказа ${order.id}`
        });
      } else {
        yookassaPayment = await yookassaService.createPayment({
          amount: order.total,
          currency: order.currency,
          orderId: order.id,
          description: `Оплата заказа ${order.id}`
        });
      }

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

  async createOrderCancellationRefund(input: { orderId: string; buyerId: string; reason?: string }) {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, buyerId: input.buyerId },
        include: { shipment: true, payments: { where: { status: 'SUCCEEDED' }, orderBy: { createdAt: 'desc' }, take: 1 } }
      });
      if (!order) throw new Error('ORDER_NOT_FOUND');
      if (order.paymentStatus !== 'PAID') throw new Error('ORDER_NOT_PAID');

      const shipmentStatus = String(order.shipment?.status ?? '').toUpperCase();
      const isAlreadyShipped =
        ['READY_FOR_SHIPMENT', 'HANDED_TO_DELIVERY', 'IN_TRANSIT', 'DELIVERED'].includes(order.status) ||
        ['SHIPPED', 'DELIVERED', 'IN_TRANSIT', 'READY_FOR_PICKUP'].includes(shipmentStatus) ||
        ['SHIPPED', 'DELIVERED', 'IN_TRANSIT'].includes(String(order.cdekStatus ?? '').toUpperCase());
      if (isAlreadyShipped) {
        throw new Error('ORDER_ALREADY_SHIPPED');
      }

      const successPayment = order.payments[0];
      const externalPaymentId = successPayment?.externalId ?? null;
      if (!externalPaymentId) throw new Error('PAYMENT_EXTERNAL_ID_NOT_FOUND');

      const succeededRefundAgg = await tx.refund.aggregate({
        where: { orderId: order.id, status: 'SUCCEEDED' },
        _sum: { amount: true }
      });
      const succeededRefundAmount = succeededRefundAgg._sum.amount ?? 0;
      const pendingRefundAgg = await tx.refund.aggregate({
        where: { orderId: order.id, status: 'PENDING' },
        _sum: { amount: true }
      });
      const pendingRefundAmount = pendingRefundAgg._sum.amount ?? 0;
      const refundableAmount = order.total - succeededRefundAmount - pendingRefundAmount;

      if (refundableAmount <= 0) {
        throw new Error('REFUND_AMOUNT_EXCEEDS_PAYMENT');
      }

      const refundAmount = order.total;
      if (refundAmount > refundableAmount) {
        throw new Error('REFUND_AMOUNT_EXCEEDS_PAYMENT');
      }

      let refundResponse: Awaited<ReturnType<typeof yookassaService.createRefund>>;
      try {
        if (order.yookassaDealId) {
          refundResponse = await yookassaService.createRefundInDeal({
            orderId: order.id,
            dealId: order.yookassaDealId,
            paymentId: externalPaymentId,
            amountKopecks: refundAmount,
            currency: order.currency,
            reason: input.reason
          });
        } else {
          refundResponse = await yookassaService.createRefund({
            paymentId: externalPaymentId,
            amount: refundAmount,
            currency: order.currency,
            orderId: order.id,
            reason: input.reason
          });
        }
      } catch (error) {
        console.error('[ORDER][CANCEL][REFUND_CREATE_FAILED]', {
          orderId: order.id,
          paymentId: externalPaymentId,
          amount: refundAmount,
          error,
          stack: error instanceof Error ? error.stack : undefined
        });
        throw new Error('REFUND_CREATE_FAILED');
      }

      const createdRefund = await tx.refund.create({
        data: {
          orderId: order.id,
          paymentId: externalPaymentId,
          externalId: refundResponse.id,
          amount: refundAmount,
          currency: order.currency,
          reason: input.reason,
          status: refundResponse.status === 'succeeded' ? 'SUCCEEDED' : 'PENDING',
          payloadJson: refundResponse.payload as Prisma.InputJsonValue
        }
      });

      const updatedOrder = await tx.order.update({
        where: { id: order.id },
        data: {
          status: 'CANCELLED',
          statusUpdatedAt: new Date(),
          paymentStatus: refundResponse.status === 'succeeded' ? 'REFUNDED' : 'REFUND_PENDING',
          payoutStatus: 'BLOCKED',
          yookassaDealStatus: order.yookassaDealId ? 'refunded' : order.yookassaDealStatus
        }
      });

      console.info('[ORDER][CANCEL]', {
        orderId: order.id,
        paymentId: externalPaymentId,
        refundId: createdRefund.externalId,
        amount: refundAmount,
        status: createdRefund.status
      });

      return { order: updatedOrder, refund: createdRefund };
    });
  },

  async processRefundWebhook(input: { externalRefundId: string; amount: string; orderId?: string; payload?: unknown }) {
    const refund = await prisma.refund.findFirst({
      where: { externalId: input.externalRefundId },
      include: { order: true }
    });
    if (!refund) return { ok: true };

    const refundAmount = rublesToKopecks(Number(input.amount));
    if (refundAmount !== refund.amount) {
      console.error('[YOOKASSA][REFUND_WEBHOOK][AMOUNT_MISMATCH]', {
        orderId: refund.orderId,
        externalRefundId: input.externalRefundId,
        expectedAmount: refund.amount,
        gotAmount: refundAmount
      });
      throw new Error('REFUND_AMOUNT_MISMATCH');
    }

    const marked = await prisma.refund.updateMany({
      where: { id: refund.id, status: { not: 'SUCCEEDED' } },
      data: {
        status: 'SUCCEEDED',
        payloadJson: input.payload ? (input.payload as Prisma.InputJsonValue) : undefined
      }
    });
    if (marked.count === 0) return { ok: true };

    const previousPaymentStatus = refund.order.paymentStatus;
    const computedNextPaymentStatus = refund.amount === refund.order.total ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
    const nextPaymentStatus = previousPaymentStatus === 'REFUNDED' ? 'REFUNDED' : computedNextPaymentStatus;

    console.info('[YOOKASSA][REFUND_WEBHOOK][MATCH]', {
      refundExternalId: input.externalRefundId,
      refundId: refund.id,
      orderId: refund.orderId,
      previousPaymentStatus,
      nextPaymentStatus
    });

    if (previousPaymentStatus !== 'REFUNDED') {
      await prisma.order.update({
        where: { id: refund.orderId },
        data: {
          paymentStatus: nextPaymentStatus,
          payoutStatus: 'BLOCKED',
          yookassaDealStatus: refund.order.yookassaDealId ? 'refunded' : refund.order.yookassaDealStatus
        }
      });
    }

    console.info('[YOOKASSA][REFUND_WEBHOOK]', {
      orderId: refund.orderId,
      paymentId: refund.paymentId,
      refundId: input.externalRefundId,
      amount: refundAmount,
      status: 'SUCCEEDED'
    });

    return { ok: true };
  },

  async processWebhook(input: {
    externalId: string;
    status: 'succeeded' | 'canceled';
    orderId: string;
    amount: string;
    dealId?: string;
    provider?: string;
    payload?: unknown;
  }) {
    const order = await prisma.order.findUnique({ where: { id: input.orderId } });
    if (!order) return { ok: true };

    const paymentAmount = Number(input.amount);
    const orderAmount = money.toRublesFloat(order.total);
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
      const resolvedDealId = input.dealId ?? extractDealIdFromPayload(input.payload);
      if (resolvedDealId && !order.yookassaDealId) {
        await prisma.order.updateMany({
          where: { id: order.id, yookassaDealId: null },
          data: { yookassaDealId: resolvedDealId, yookassaDealStatus: 'open' }
        });
      }
      if (input.payload) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: {
            payloadJson: mergePaymentPayloadWithWebhook(payment.payloadJson, input.payload, resolvedDealId ?? null)
          }
        });
      }
      return { ok: true };
    }

    if (input.status === 'succeeded') {
      const resolvedDealId = input.dealId ?? extractDealIdFromPayload(input.payload);
      const updateResult = await prisma.payment.updateMany({
        where: {
          externalId: input.externalId,
          status: { not: 'SUCCEEDED' }
        },
        data: { status: 'SUCCEEDED' }
      });

      if (updateResult.count === 0) return { ok: true };

      await prisma.payment.update({
        where: { id: payment.id },
        data: {
          payloadJson: mergePaymentPayloadWithWebhook(payment.payloadJson, input.payload, resolvedDealId)
        }
      });

      await prisma.order.update({
        where: { id: order.id },
        data: {
          status: 'PAID',
          paymentStatus: 'PAID',
          paymentExpiresAt: null,
          paidAt: new Date(),
          paymentProvider: input.provider ?? payment.provider,
          paymentId: payment.id,
          payoutStatus: 'HOLD',
          yookassaDealId: order.yookassaDealId ?? resolvedDealId ?? undefined,
          yookassaDealStatus:
            order.yookassaDealId ?? resolvedDealId ? 'open' : order.yookassaDealStatus
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
