import crypto from 'node:crypto';
import axios from 'axios';
import { prisma } from '../lib/prisma';
import { money } from '../utils/money';
import { yookassaService } from './yookassaService';
import { env } from '../config/env';

const PROVIDER = 'YOOKASSA';

const PAYMENT_STATUS_REFUND_SET = new Set(['REFUND_PENDING', 'REFUNDED']);
const BLOCKED_PAYOUT_STATUSES = new Set(['BLOCKED', 'FAILED', 'PAYOUT_CANCELED']);
const AWAITING_PAYOUT_STATUSES = new Set(['AWAITING_PAYOUT', 'RELEASED']);
const FROZEN_PAYOUT_STATUSES = new Set(['HOLD']);
const PAYOUT_PENDING_STATUSES = new Set(['PAYOUT_PENDING', 'PROCESSING']);
const SUCCESS_PAYOUT_STATUSES = new Set(['PAID', 'PAID_OUT']);
const ALLOCATION_CONSUMING_PAYOUT_STATUSES = ['PENDING', 'WAITING_FOR_CAPTURE', 'PROCESSING', 'SUCCEEDED'] as const;
const ALLOCATION_PENDING_PAYOUT_STATUSES = ['PENDING', 'WAITING_FOR_CAPTURE', 'PROCESSING'] as const;
const MIN_PAYOUT_AMOUNT_KOPECKS = 100;
const MAX_PAYOUT_AMOUNT_KOPECKS = 15_000_000;

const normalizePayoutStatus = (status?: string | null) => String(status ?? '').toUpperCase();
const DEFAULT_TEST_PAYOUT_DESCRIPTION = 'Тестовая выплата продавцу';
const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const extractDealIdFromPayloadJson = (payloadJson: unknown): string | null => {
  const payload = asObject(payloadJson);
  if (!payload) return null;
  const objectNode = asObject(payload.object);
  const metadata = asObject(payload.metadata) ?? asObject(objectNode?.metadata);
  const deal = asObject(payload.deal) ?? asObject(objectNode?.deal);
  const directDealId = toNonEmptyString(payload.dealId) ?? toNonEmptyString(payload.yookassaDealId);
  if (directDealId) return directDealId;
  const metadataDealId = toNonEmptyString(metadata?.dealId);
  if (metadataDealId) return metadataDealId;
  const dealObjectId = toNonEmptyString(deal?.id);
  if (dealObjectId) return dealObjectId;
  return null;
};

function resolveDealId(order: any, payment?: any): { dealId: string | null; source: string | null; diagnostics: Record<string, unknown> } {
  const candidates = [
    { source: 'order.yookassaDealId', value: toNonEmptyString(order?.yookassaDealId) },
    { source: 'payment.yookassaDealId', value: toNonEmptyString(payment?.yookassaDealId) },
    { source: 'payment.dealId', value: toNonEmptyString(payment?.dealId) },
    { source: 'payment.metadata.dealId', value: toNonEmptyString(asObject(payment?.metadata)?.dealId) },
    { source: 'payment.payloadJson', value: extractDealIdFromPayloadJson(payment?.payloadJson) }
  ];
  const match = candidates.find((item) => Boolean(item.value));
  return {
    dealId: match?.value ?? null,
    source: match?.source ?? null,
    diagnostics: {
      orderId: order?.id ?? null,
      orderPaymentId: order?.paymentId ?? null,
      orderDealId: order?.yookassaDealId ?? null,
      paymentId: payment?.id ?? null,
      paymentStatus: payment?.status ?? null,
      paymentHasPayloadJson: Boolean(payment?.payloadJson),
      paymentHasMetadata: Boolean(payment?.metadata),
      paymentDealIdFromPayload: extractDealIdFromPayloadJson(payment?.payloadJson),
      checkedSources: candidates.map((item) => item.source)
    }
  };
}

class SellerPayoutError extends Error {
  code: string;
  httpStatus: number;
  details?: Record<string, unknown>;

  constructor(code: string, httpStatus: number, details?: Record<string, unknown>) {
    super(code);
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}


type YooKassaWidgetConfig = {
  enabled: boolean;
  type: 'safedeal';
  accountId: string | null;
  hasSavedCard: boolean;
  card: {
    cardType: string | null;
    first6: string | null;
    last4: string | null;
    issuerCountry: string | null;
    issuerName: string | null;
    tokenUpdatedAt: string | null;
  } | null;
  reason?: string;
};

type EligibleOrderForPayout = {
  orderId: string;
  publicNumber: string;
  dealId: string | null;
  currency: string;
  availableToPayoutKopecks: number;
  createdAt: Date;
  paidAt: Date | null;
};
const buildMethodMaskedLabel = (method: {
  methodType: string;
  cardType?: string | null;
  cardLast4?: string | null;
  yoomoneyAccountNumber?: string | null;
}) => {
  if (method.methodType === 'BANK_CARD') {
    const cardType = method.cardType ?? 'Card';
    const last4 = method.cardLast4 ?? '••••';
    return `${cardType} •••• ${last4}`;
  }

  const wallet = method.yoomoneyAccountNumber ?? '';
  const last4 = wallet.slice(-4).padStart(4, '•');
  return `YooMoney •••• ${last4}`;
};

export const sellerPayoutService = {
  normalizePayoutAmountKopecks(amount: string | number) {
    if (typeof amount === 'number') {
      if (!Number.isFinite(amount)) throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, { message: 'Некорректная сумма выплаты.' });
      return money.toKopecks(amount);
    }

    const normalized = amount.trim().replace(',', '.');
    if (!normalized) throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, { message: 'Некорректная сумма выплаты.' });
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, { message: 'Некорректная сумма выплаты.' });
    return money.toKopecks(numeric);
  },

  async resolveDealIdForPayout(sellerId: string, requestedDealId?: string) {
    if (requestedDealId?.trim()) return requestedDealId.trim();
    const orderWithDeal = await prisma.order.findFirst({
      where: {
        items: { some: { product: { sellerId } } },
        yookassaDealId: { not: null },
        paymentStatus: 'PAID'
      },
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, yookassaDealId: true, publicNumber: true }
    });
    return {
      dealId: orderWithDeal?.yookassaDealId ?? null,
      orderId: orderWithDeal?.id ?? null,
      orderPublicNumber: orderWithDeal?.publicNumber ?? null
    };
  },

  async resolveOrderDealIdForPayout(params: { sellerId: string; orderId: string; tx?: any }) {
    const db = params.tx ?? prisma;
    const order = await db.order.findFirst({
      where: { id: params.orderId, items: { some: { product: { sellerId: params.sellerId } } } },
      select: {
        id: true,
        publicNumber: true,
        paymentId: true,
        yookassaDealId: true,
        status: true,
        paymentStatus: true,
        payoutStatus: true,
        sellerNetAmountKopecks: true
      }
    });
    if (!order) throw new Error('ORDER_NOT_FOUND');

    if (order.yookassaDealId) {
      return { dealId: order.yookassaDealId, order, payment: null };
    }

    const payment = await db.payment.findFirst({
      where: { orderId: order.id },
      orderBy: [{ createdAt: 'desc' }],
      select: { id: true, status: true, payloadJson: true }
    });
    const resolved = resolveDealId(order, payment);
    const paymentDealId = resolved.dealId;

    if (paymentDealId) {
      await db.order.update({
        where: { id: order.id },
        data: {
          yookassaDealId: paymentDealId,
          yookassaDealStatus: 'open'
        }
      });
      console.info('[PAYOUT][DEAL_RESOLVED]', {
        sellerId: params.sellerId,
        orderId: order.id,
        publicNumber: order.publicNumber,
        resolvedDealId: paymentDealId,
        source: resolved.source
      });
      return { dealId: paymentDealId, order, payment };
    }

    console.error('[PAYOUT][DEAL_NOT_FOUND]', {
      sellerId: params.sellerId,
      orderId: order.id,
      publicNumber: order.publicNumber,
      paymentId: order.paymentId ?? payment?.id ?? null,
      orderDealId: order.yookassaDealId ?? null,
      paymentDealId: paymentDealId ?? null,
      paymentStatus: payment?.status ?? null,
      orderStatus: order.status ?? null,
      orderPaymentStatus: order.paymentStatus ?? null,
      payoutStatus: order.payoutStatus,
      availableToPayoutMinor: order.sellerNetAmountKopecks ?? null,
      diagnostics: resolved.diagnostics
    });
    return { dealId: null, order, payment };
  },

  async triggerTestPayout({
    sellerId,
    amount,
    description,
    metadata,
    dealId
  }: {
    sellerId: string;
    amount: string | number;
    description?: string;
    metadata?: Record<string, string>;
    dealId?: string;
  }) {
    console.log('[trigger payout] sellerId', sellerId);
    console.log('[trigger payout] amount raw', amount);
    if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY || !process.env.YOOKASSA_MODE) {
      throw new SellerPayoutError('SELLER_PAYOUT_CONFIG_ERROR', 500, { message: 'Не настроены параметры YooKassa для выплат.' });
    }

    const payoutMethod = await (prisma as any).sellerPayoutMethod.findFirst({
      where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD', status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
    });
    console.log('[trigger payout] payout method found', payoutMethod?.id);
    console.log('[trigger payout] payout token exists', Boolean(payoutMethod?.payoutToken));
    if (!payoutMethod || payoutMethod.status === 'REVOKED') {
      throw new SellerPayoutError('SELLER_PAYOUT_METHOD_NOT_FOUND', 404, { message: 'У продавца нет активного способа выплаты.' });
    }
    if (!payoutMethod.payoutToken) {
      throw new SellerPayoutError('SELLER_PAYOUT_TOKEN_MISSING', 400, { message: 'Для выбранного способа выплаты не найден payout token.' });
    }

    const amountKopecks = this.normalizePayoutAmountKopecks(amount);
    const normalizedAmount = money.toRublesString(amountKopecks);
    console.log('[trigger payout] normalized amount', normalizedAmount);
    if (amountKopecks <= 0) {
      throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, { message: 'Некорректная сумма выплаты.' });
    }
    if (amountKopecks < MIN_PAYOUT_AMOUNT_KOPECKS) {
      throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_TOO_SMALL', 400, { message: 'Минимальная сумма выплаты — 1 ₽.' });
    }
    if (amountKopecks > MAX_PAYOUT_AMOUNT_KOPECKS) {
      throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_TOO_LARGE', 400, { message: 'Максимальная сумма выплаты на карту — 150 000 ₽.' });
    }

    const availableKopecks = await this.calculateAvailableBalanceKopecks(sellerId);
    if (amountKopecks > availableKopecks) {
      throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_EXCEEDS_AVAILABLE', 400, { message: 'Сумма выплаты превышает доступный баланс.' });
    }

    const resolvedDeal = await this.resolveDealIdForPayout(sellerId, dealId);
    const resolvedDealId = typeof resolvedDeal === 'string' ? resolvedDeal : resolvedDeal.dealId;
    const resolvedOrderId = typeof resolvedDeal === 'string' ? null : resolvedDeal.orderId;
    const resolvedOrderPublicNumber = typeof resolvedDeal === 'string' ? null : resolvedDeal.orderPublicNumber;
    console.log('[trigger payout] dealId', resolvedDealId);
    if (!resolvedDealId) {
      throw new SellerPayoutError('SELLER_PAYOUT_DEAL_NOT_FOUND', 400, { message: 'Не найден deal.id для создания выплаты.' });
    }

    const idempotenceKey = crypto.randomUUID();
    const payoutDescription = description?.trim() || DEFAULT_TEST_PAYOUT_DESCRIPTION;
    const requestBody = {
      amount: { value: normalizedAmount, currency: 'RUB' },
      payout_token: payoutMethod.payoutToken,
      description: payoutDescription,
      metadata: { source: 'seller-dashboard', mode: 'test', ...(metadata ?? {}) },
      deal: { id: resolvedDealId }
    };
    console.log('[trigger payout] request body', requestBody);

    let externalPayout: any;
    try {
      externalPayout = await yookassaService.createPayoutInDeal({
        orderId: resolvedOrderId ?? `seller-${sellerId}-trigger-test`,
        dealId: resolvedDealId,
        sellerAmountKopecks: amountKopecks,
        currency: 'RUB',
        payoutToken: payoutMethod.payoutToken,
        idempotenceKey,
        description: payoutDescription,
        metadata: requestBody.metadata
      });
      console.log('[trigger payout] yookassa response', externalPayout);
    } catch (error) {
      console.error('[trigger payout] failed', error);
      const providerMessage = axios.isAxiosError(error)
        ? String((error.response?.data as any)?.description ?? error.message)
        : String(error);
      throw new SellerPayoutError('SELLER_PAYOUT_PROVIDER_ERROR', 502, {
        message: 'Не удалось создать выплату в YooKassa.',
        providerMessage
      });
    }

    const now = new Date();
    const mappedStatus = externalPayout.status === 'succeeded' ? 'SUCCEEDED' : externalPayout.status === 'canceled' ? 'CANCELED' : 'PENDING';
    const created = await (prisma as any).sellerPayout.create({
      data: {
        sellerId,
        orderId: resolvedOrderId,
        dealId: resolvedDealId,
        payoutMethodId: payoutMethod.id,
        provider: PROVIDER,
        externalPayoutId: externalPayout.id,
        amountKopecks,
        currency: 'RUB',
        status: mappedStatus,
        externalStatus: externalPayout.status ?? null,
        description: payoutDescription,
        metadata: requestBody.metadata,
        idempotenceKey,
        requestedAt: now,
        succeededAt: mappedStatus === 'SUCCEEDED' ? now : null,
        canceledAt: mappedStatus === 'CANCELED' ? now : null,
        rawResponse: externalPayout
      }
    });

    return {
      id: created.externalPayoutId ?? created.id,
      status: String(externalPayout.status ?? 'pending').toLowerCase(),
      amount: {
        value: normalizedAmount,
        currency: 'RUB'
      },
      description: created.description,
      createdAt: created.createdAt,
      dealId: resolvedDealId,
      test: true,
      orderPublicNumber: resolvedOrderPublicNumber
    };
  },

  getSafeDealShopId() {
    const shopId = process.env.YOOKASSA_SHOP_ID?.trim() || null;
    return shopId;
  },

  async getYookassaPayoutDetails(sellerId: string) {
    const method = await (prisma as any).sellerPayoutMethod.findFirst({
      where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD', status: { in: ['ACTIVE', 'INVALID'] } },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
    });

    if (!method) return null;

    return {
      hasSavedCard: true,
      card: {
        cardType: method.cardType ?? null,
        first6: method.cardFirst6 ?? null,
        last4: method.cardLast4 ?? null,
        issuerCountry: method.cardIssuerCountry ?? null,
        issuerName: method.cardIssuerName ?? null,
        tokenUpdatedAt: method.updatedAt?.toISOString?.() ?? null
      }
    };
  },

  async getYooKassaWidgetConfig(sellerId: string): Promise<YooKassaWidgetConfig> {
    const shopId = this.getSafeDealShopId();

    if (!shopId) {
      return {
        enabled: false,
        type: 'safedeal',
        accountId: null,
        hasSavedCard: false,
        card: null,
        reason: 'YOOKASSA_SHOP_ID is not configured'
      };
    }

    const payoutDetails = await this.getYookassaPayoutDetails(sellerId);

    return {
      enabled: true,
      type: 'safedeal',
      accountId: shopId,
      hasSavedCard: Boolean(payoutDetails?.hasSavedCard),
      card: payoutDetails?.card ?? null
    };
  },


  async getYookassaWidgetConfig(sellerId: string): Promise<YooKassaWidgetConfig> {
    return this.getYooKassaWidgetConfig(sellerId);
  },
  async saveYookassaCardFromWidget(
    sellerId: string,
    payload: {
      payoutToken: string;
      first6?: string;
      last4: string;
      cardType?: string;
      issuerCountry?: string;
      issuerName?: string;
    }
  ) {
    const { payoutToken, first6, last4, issuerName, issuerCountry, cardType } = payload;

    const methodData = {
      sellerId,
      provider: PROVIDER,
      methodType: 'BANK_CARD',
      payoutToken,
      cardFirst6: first6 ?? null,
      cardLast4: last4,
      cardType: cardType ?? null,
      cardIssuerCountry: issuerCountry ?? null,
      cardIssuerName: issuerName ?? null,
      maskedLabel: buildMethodMaskedLabel({
        methodType: 'BANK_CARD',
        cardType: cardType ?? null,
        cardLast4: last4
      }),
      status: 'ACTIVE'
    } as const;

    const savedMethod = await prisma.$transaction(async (tx) => {
      const existing = await (tx as any).sellerPayoutMethod.findFirst({
        where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD' },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
      });

      if (existing) {
        await (tx as any).sellerPayoutMethod.updateMany({
          where: { sellerId, isDefault: true },
          data: { isDefault: false }
        });
        const updated = await (tx as any).sellerPayoutMethod.update({
          where: { id: existing.id },
          data: { ...methodData, isDefault: true }
        });
        await (tx as any).sellerPayoutMethod.updateMany({
          where: { sellerId, methodType: 'BANK_CARD', NOT: { id: existing.id } },
          data: { status: 'REVOKED', isDefault: false }
        });
        return updated;
      } else {
        return (tx as any).sellerPayoutMethod.create({
          data: {
            ...methodData,
            isDefault: true
          }
        });
      }
    });
    console.log('[saved payout method]', savedMethod);

    return {
      cardType: cardType ?? null,
      first6: first6 ?? null,
      last4,
      issuerCountry: issuerCountry ?? null,
      issuerName: issuerName ?? null
    };
  },

  async listPayoutMethods(sellerId: string) {
    const methods = await (prisma as any).sellerPayoutMethod.findMany({
      where: { sellerId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
    });

    return methods.map((method: any) => ({
      id: method.id,
      provider: method.provider,
      methodType: method.methodType,
      status: method.status,
      isDefault: Boolean(method.isDefault),
      maskedLabel: method.maskedLabel ?? buildMethodMaskedLabel(method),
      cardLast4: method.cardLast4,
      cardType: method.cardType,
      yoomoneyAccountNumber: method.methodType === 'YOOMONEY' ? method.yoomoneyAccountNumber : null,
      createdAt: method.createdAt,
      updatedAt: method.updatedAt
    }));
  },

  async createPayoutMethod(sellerId: string, payload: Record<string, unknown>) {
    const isDefault = Boolean(payload.isDefault);
    const methodType = String(payload.methodType);
    const maskedLabel = buildMethodMaskedLabel({
      methodType,
      cardType: (payload.cardType as string | undefined) ?? null,
      cardLast4: (payload.cardLast4 as string | undefined) ?? null,
      yoomoneyAccountNumber: (payload.yoomoneyAccountNumber as string | undefined) ?? null
    });

    return prisma.$transaction(async (tx) => {
      if (isDefault) {
        await (tx as any).sellerPayoutMethod.updateMany({
          where: { sellerId, isDefault: true },
          data: { isDefault: false }
        });
      }

      const created = await (tx as any).sellerPayoutMethod.create({
        data: {
          sellerId,
          provider: PROVIDER,
          methodType,
          payoutToken: (payload.payoutToken as string | undefined) ?? null,
          cardFirst6: (payload.cardFirst6 as string | undefined) ?? null,
          cardLast4: (payload.cardLast4 as string | undefined) ?? null,
          cardType: (payload.cardType as string | undefined) ?? null,
          cardIssuerCountry: (payload.cardIssuerCountry as string | undefined) ?? null,
          cardIssuerName: (payload.cardIssuerName as string | undefined) ?? null,
          yoomoneyAccountNumber: (payload.yoomoneyAccountNumber as string | undefined) ?? null,
          maskedLabel,
          status: 'ACTIVE',
          isDefault,
          meta: (payload.meta as any) ?? null
        }
      });

      if (!isDefault) {
        const hasDefault = await (tx as any).sellerPayoutMethod.findFirst({ where: { sellerId, isDefault: true } });
        if (!hasDefault) {
          await (tx as any).sellerPayoutMethod.update({ where: { id: created.id }, data: { isDefault: true } });
          created.isDefault = true;
        }
      }

      return created;
    });
  },

  async setDefaultMethod(sellerId: string, methodId: string) {
    return prisma.$transaction(async (tx) => {
      const method = await (tx as any).sellerPayoutMethod.findFirst({ where: { id: methodId, sellerId } });
      if (!method) return null;

      await (tx as any).sellerPayoutMethod.updateMany({
        where: { sellerId, isDefault: true },
        data: { isDefault: false }
      });

      return (tx as any).sellerPayoutMethod.update({
        where: { id: methodId },
        data: { isDefault: true, status: method.status === 'REVOKED' ? 'ACTIVE' : method.status }
      });
    });
  },

  async revokeMethod(sellerId: string, methodId: string) {
    return prisma.$transaction(async (tx) => {
      const method = await (tx as any).sellerPayoutMethod.findFirst({ where: { id: methodId, sellerId } });
      if (!method) return null;

      await (tx as any).sellerPayoutMethod.update({
        where: { id: methodId },
        data: { status: 'REVOKED', isDefault: false }
      });

      if (method.isDefault) {
        const replacement = await (tx as any).sellerPayoutMethod.findFirst({
          where: { sellerId, status: 'ACTIVE', NOT: { id: methodId } },
          orderBy: { createdAt: 'asc' }
        });
        if (replacement) {
          await (tx as any).sellerPayoutMethod.update({ where: { id: replacement.id }, data: { isDefault: true } });
        }
      }

      return { ...method, status: 'REVOKED', isDefault: false };
    });
  },

  async getEligibleOrdersForPayout(
    tx: any,
    sellerId: string,
    options?: { debug?: boolean; debugLabel?: string }
  ): Promise<EligibleOrderForPayout[]> {
    const orders = await tx.order.findMany({
      where: {
        items: { some: { product: { sellerId } } },
        paymentStatus: 'PAID',
        payoutStatus: { in: ['RELEASED', 'AWAITING_PAYOUT'] },
      },
      select: {
        id: true,
        publicNumber: true,
        paymentId: true,
        yookassaDealId: true,
        status: true,
        payoutStatus: true,
        paymentStatus: true,
        currency: true,
        sellerNetAmountKopecks: true,
        total: true,
        createdAt: true,
        paidAt: true
      },
      orderBy: [{ paidAt: 'asc' }, { createdAt: 'asc' }]
    });

    if (!orders.length) return [];
    const orderIds = orders.map((item) => item.id);
    const allocationRows = await (tx as any).sellerPayoutAllocation.findMany({
      where: {
        orderId: { in: orderIds },
        payout: {
          status: { in: [...ALLOCATION_CONSUMING_PAYOUT_STATUSES] }
        }
      },
      select: {
        orderId: true,
        amountKopecks: true
      }
    });

    const allocatedByOrder = new Map<string, number>();
    for (const row of allocationRows) {
      allocatedByOrder.set(row.orderId, (allocatedByOrder.get(row.orderId) ?? 0) + Number(row.amountKopecks ?? 0));
    }

    const missingDealOrderIds = orders.filter((item) => !item.yookassaDealId).map((item) => item.id);
    const dealByOrderId = new Map<string, string>();
    if (missingDealOrderIds.length > 0) {
      const relatedPayments = await tx.payment.findMany({
        where: { orderId: { in: missingDealOrderIds } },
        select: { id: true, orderId: true, status: true, payloadJson: true, createdAt: true },
        orderBy: [{ createdAt: 'desc' }]
      });
      for (const payment of relatedPayments) {
        if (dealByOrderId.has(payment.orderId)) continue;
        const dealId = extractDealIdFromPayloadJson(payment.payloadJson);
        if (!dealId) continue;
        dealByOrderId.set(payment.orderId, dealId);
      }
      const backfilledOrders = Array.from(dealByOrderId.entries());
      if (backfilledOrders.length > 0) {
        await Promise.all(
          backfilledOrders.map(([orderId, dealId]) =>
            tx.order.updateMany({
              where: { id: orderId, yookassaDealId: null },
              data: { yookassaDealId: dealId, yookassaDealStatus: 'open' }
            })
          )
        );
        console.info('[PAYOUT][DEAL_BACKFILL_FROM_PAYMENT_PAYLOAD]', {
          sellerId,
          count: backfilledOrders.length,
          orders: backfilledOrders.map(([orderId, dealId]) => ({ orderId, dealId }))
        });
      }
    }

    const rawEligible = orders
      .map((order) => {
        const netAmount = Number(order.sellerNetAmountKopecks ?? order.total ?? 0);
        const allocated = allocatedByOrder.get(order.id) ?? 0;
        const availableToPayoutKopecks = Math.max(0, netAmount - allocated);
        const resolvedDealId = order.yookassaDealId ?? dealByOrderId.get(order.id) ?? null;
        return {
          orderId: order.id,
          publicNumber: order.publicNumber,
          dealId: resolvedDealId,
          currency: order.currency,
          availableToPayoutKopecks,
          createdAt: order.createdAt,
          paidAt: order.paidAt
        };
      })
      .filter((item) => item.availableToPayoutKopecks > 0);

    if (options?.debug) {
      const missingDealOrders = rawEligible.filter((item) => !item.dealId);
      const eligibleWithDeal = rawEligible.filter((item) => Boolean(item.dealId));
      const totalAvailable = rawEligible.reduce((acc, item) => acc + item.availableToPayoutKopecks, 0);
      const totalAvailableWithDeal = eligibleWithDeal.reduce((acc, item) => acc + item.availableToPayoutKopecks, 0);
      const label = options.debugLabel ?? 'createFinancePayoutByAmount';
      console.info(
        `[seller payout][${label}] eligible summary`,
        {
          sellerId,
          ordersChecked: orders.length,
          eligibleOrders: rawEligible.length,
          eligibleOrderIds: rawEligible.map((item) => item.orderId),
          totalAvailableKopecks: totalAvailable,
          eligibleWithDealOrders: eligibleWithDeal.length,
          eligibleWithDealOrderIds: eligibleWithDeal.map((item) => item.orderId),
          totalAvailableWithDealKopecks: totalAvailableWithDeal,
          filteredOutReasons: {
            zeroAvailableAfterAllocations: orders.length - rawEligible.length,
            missingDealId: missingDealOrders.length
          },
          filteredOutOrders: missingDealOrders.map((item) => ({
            orderId: item.orderId,
            publicNumber: item.publicNumber,
            availableToPayoutKopecks: item.availableToPayoutKopecks,
            dealId: item.dealId
          }))
        }
      );
    }

    return rawEligible;
  },

  async calculateAvailableBalanceKopecks(sellerId: string) {
    const eligible = await this.getEligibleOrdersForPayout(prisma, sellerId);
    return eligible.reduce((acc, item) => acc + item.availableToPayoutKopecks, 0);
  },

  async createSellerPayout(
    sellerId: string,
    payload: { amount: string; description?: string; orderId?: string | null; mode?: 'live' | 'test' }
  ) {
    const amountRubles = Number(payload.amount);
    if (!Number.isFinite(amountRubles) || amountRubles <= 0) {
      throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400);
    }

    const amountKopecks = money.toKopecks(amountRubles);
    if (amountKopecks < MIN_PAYOUT_AMOUNT_KOPECKS) {
      throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, {
        min: money.toRublesString(MIN_PAYOUT_AMOUNT_KOPECKS)
      });
    }
    if (amountKopecks > MAX_PAYOUT_AMOUNT_KOPECKS) {
      throw new SellerPayoutError('SELLER_PAYOUT_LIMIT_EXCEEDED', 400, {
        max: money.toRublesString(MAX_PAYOUT_AMOUNT_KOPECKS)
      });
    }

    const payoutMethod = await (prisma as any).sellerPayoutMethod.findFirst({
      where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD', status: 'ACTIVE' },
      orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
    });
    if (!payoutMethod) throw new SellerPayoutError('SELLER_PAYOUT_METHOD_NOT_FOUND', 404);
    if (!payoutMethod.payoutToken) throw new SellerPayoutError('SELLER_PAYOUT_TOKEN_MISSING', 400);

    const mode = payload.mode === 'test' ? 'test' : 'live';
    const allowTestBypass = mode === 'test' && process.env.NODE_ENV !== 'production';
    const availableKopecks = await this.calculateAvailableBalanceKopecks(sellerId);
    if (!allowTestBypass && amountKopecks > availableKopecks) {
      throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_EXCEEDS_AVAILABLE', 400, {
        requested: money.toRublesString(amountKopecks),
        available: money.toRublesString(availableKopecks)
      });
    }

    const orderForDeal = payload.orderId
      ? await this.resolveOrderDealIdForPayout({ sellerId, orderId: payload.orderId })
      : await prisma.order.findFirst({
          where: {
            items: { some: { product: { sellerId } } },
            yookassaDealId: { not: null },
            paymentStatus: 'PAID'
          },
          orderBy: { paidAt: 'desc' },
          select: { id: true, publicNumber: true, yookassaDealId: true }
        });

    const fallbackTestDealId = process.env.YOOKASSA_TEST_DEAL_ID?.trim() || null;
    const dealId = ('dealId' in (orderForDeal ?? {}) ? (orderForDeal as any)?.dealId : (orderForDeal as any)?.yookassaDealId) ?? (mode === 'test' ? fallbackTestDealId : null);
    if (!dealId) {
      throw new SellerPayoutError('SELLER_PAYOUT_DEAL_NOT_FOUND', 400, {
        mode,
        orderId: payload.orderId ?? null,
        hint: mode === 'test' ? 'Set YOOKASSA_TEST_DEAL_ID or create paid order with yookassaDealId' : null
      });
    }

    const resolvedOrderEntityId = (orderForDeal as any)?.order?.id ?? (orderForDeal as any)?.id ?? null;
    const resolvedOrderPublicNumber = (orderForDeal as any)?.order?.publicNumber ?? (orderForDeal as any)?.publicNumber ?? null;
    const referenceOrderId = resolvedOrderEntityId ?? payload.orderId ?? `seller-${sellerId}-test`;

    const idempotenceKey = this.buildStableIdempotenceKey([
      'seller',
      sellerId,
      referenceOrderId,
      payoutMethod.id,
      String(amountKopecks),
      String(Date.now())
    ]);

    let externalPayout: any;
    try {
      externalPayout = await yookassaService.createPayoutInDeal({
        orderId: referenceOrderId,
        dealId,
        sellerAmountKopecks: amountKopecks,
        currency: 'RUB',
        payoutToken: payoutMethod.payoutToken,
        idempotenceKey
      });
    } catch (error) {
      throw new SellerPayoutError('SELLER_PAYOUT_PROVIDER_ERROR', 502, { cause: String(error) });
    }

    const now = new Date();
    const mappedStatus = externalPayout.status === 'succeeded' ? 'SUCCEEDED' : externalPayout.status === 'canceled' ? 'CANCELED' : 'PENDING';
    const created = await (prisma as any).sellerPayout.create({
      data: {
        sellerId,
        orderId: resolvedOrderEntityId,
        dealId,
        payoutMethodId: payoutMethod.id,
        provider: PROVIDER,
        externalPayoutId: externalPayout.id,
        amountKopecks,
        currency: 'RUB',
        status: mappedStatus,
        externalStatus: externalPayout.status ?? null,
        description: payload.description?.trim() || 'Выплата продавцу',
        metadata: {
          orderId: resolvedOrderEntityId,
          orderPublicNumber: resolvedOrderPublicNumber,
          mode,
          availableBalanceBypass: allowTestBypass || undefined
        },
        idempotenceKey,
        requestedAt: now,
        succeededAt: mappedStatus === 'SUCCEEDED' ? now : null,
        canceledAt: mappedStatus === 'CANCELED' ? now : null,
        rawResponse: externalPayout
      }
    });

    return created;
  },

  async createFinancePayoutByAmount(
    sellerId: string,
    payload: { amount: string | number; description?: string }
  ) {
    let amountKopecks: number;
    try {
      amountKopecks = this.normalizePayoutAmountKopecks(payload.amount);
    } catch (error) {
      if (this.isSellerPayoutError(error) && error.code === 'SELLER_PAYOUT_AMOUNT_INVALID') {
        throw new SellerPayoutError('INVALID_PAYOUT_AMOUNT', 400);
      }
      throw error;
    }
    if (amountKopecks <= 0) {
      throw new SellerPayoutError('INVALID_PAYOUT_AMOUNT', 400);
    }
    if (amountKopecks < MIN_PAYOUT_AMOUNT_KOPECKS) {
      throw new SellerPayoutError('INVALID_PAYOUT_AMOUNT', 400, { min: money.toRublesString(MIN_PAYOUT_AMOUNT_KOPECKS) });
    }
    if (amountKopecks > MAX_PAYOUT_AMOUNT_KOPECKS) {
      throw new SellerPayoutError('INVALID_PAYOUT_AMOUNT', 400, { max: money.toRublesString(MAX_PAYOUT_AMOUNT_KOPECKS) });
    }

    const payoutMethod = await (prisma as any).sellerPayoutMethod.findFirst({
      where: { sellerId, isDefault: true, provider: PROVIDER, status: 'ACTIVE' },
      orderBy: [{ updatedAt: 'desc' }]
    });
    if (!payoutMethod) throw new SellerPayoutError('DEFAULT_PAYOUT_METHOD_NOT_FOUND', 404);
    if (!payoutMethod.payoutToken) throw new SellerPayoutError('DEFAULT_PAYOUT_METHOD_NOT_FOUND', 404);

    const reserved = await prisma.$transaction(async (tx) => {
      const inProgressPayout = await (tx as any).sellerPayout.findFirst({
        where: {
          sellerId,
          status: { in: [...ALLOCATION_PENDING_PAYOUT_STATUSES] }
        },
        orderBy: [{ createdAt: 'desc' }]
      });
      if (inProgressPayout) {
        throw new SellerPayoutError('PAYOUT_ALREADY_IN_PROGRESS', 409);
      }

      const eligibleOrders = await this.getEligibleOrdersForPayout(tx, sellerId, {
        debug: true,
        debugLabel: 'finance-payout'
      });
      if (!eligibleOrders.length) {
        throw new SellerPayoutError('NO_FUNDS_AVAILABLE_FOR_PAYOUT', 400);
      }

      const totalAvailable = eligibleOrders.reduce((acc, item) => acc + item.availableToPayoutKopecks, 0);
      if (amountKopecks > totalAvailable) {
        throw new SellerPayoutError('INSUFFICIENT_AVAILABLE_BALANCE', 400, {
          requested: money.toRublesString(amountKopecks),
          available: money.toRublesString(totalAvailable)
        });
      }

      const eligibleOrdersWithDeal = eligibleOrders.filter((item) => Boolean(item.dealId));
      if (!eligibleOrdersWithDeal.length) {
        const missingDealDiagnostics = await tx.order.findMany({
          where: {
            id: { in: eligibleOrders.map((item) => item.orderId) }
          },
          select: {
            id: true,
            publicNumber: true,
            paymentId: true,
            yookassaDealId: true,
            status: true,
            paymentStatus: true,
            payoutStatus: true
          }
        });
        const payments = await tx.payment.findMany({
          where: { orderId: { in: missingDealDiagnostics.map((item) => item.id) } },
          orderBy: [{ createdAt: 'desc' }],
          select: { id: true, orderId: true, status: true, payloadJson: true }
        });
        const latestPaymentByOrder = new Map<string, any>();
        for (const payment of payments) {
          if (!latestPaymentByOrder.has(payment.orderId)) {
            latestPaymentByOrder.set(payment.orderId, payment);
          }
        }
        console.error('[PAYOUT][DEAL_NOT_FOUND][FINANCE_PAYOUT]', {
          sellerId,
          requestedAmountKopecks: amountKopecks,
          checkedOrderCount: missingDealDiagnostics.length,
          orders: missingDealDiagnostics.map((order) => {
            const payment = latestPaymentByOrder.get(order.id) ?? null;
            return {
              orderId: order.id,
              orderPublicNumber: order.publicNumber,
              orderPaymentId: order.paymentId,
              orderYookassaDealId: order.yookassaDealId,
              foundPaymentId: payment?.id ?? null,
              paymentStatus: payment?.status ?? null,
              paymentHasPayloadJson: Boolean(payment?.payloadJson),
              paymentDealIdFromPayloadJson: extractDealIdFromPayloadJson(payment?.payloadJson),
              payoutStatus: order.payoutStatus,
              orderStatus: order.status,
              orderPaymentStatus: order.paymentStatus
            };
          })
        });
        throw new SellerPayoutError('SELLER_PAYOUT_DEAL_NOT_FOUND', 400, {
          message: 'Для доступных средств не найден deal.id'
        });
      }

      const primaryDealId = String(eligibleOrdersWithDeal[0].dealId);
      const primaryDealAvailable = eligibleOrdersWithDeal
        .filter((item) => item.dealId === primaryDealId)
        .reduce((acc, item) => acc + item.availableToPayoutKopecks, 0);
      if (amountKopecks > primaryDealAvailable) {
        throw new SellerPayoutError('MULTI_DEAL_PAYOUT_NOT_SUPPORTED', 400, {
          requested: money.toRublesString(amountKopecks),
          maxSingleDealAmount: money.toRublesString(primaryDealAvailable),
          dealId: primaryDealId
        });
      }

      const allocations: Array<{ orderId: string; publicNumber: string; amountKopecks: number }> = [];
      let remaining = amountKopecks;
      for (const order of eligibleOrders) {
        if (order.dealId !== primaryDealId || remaining <= 0) continue;
        const chunk = Math.min(remaining, order.availableToPayoutKopecks);
        if (chunk <= 0) continue;
        allocations.push({ orderId: order.orderId, publicNumber: order.publicNumber, amountKopecks: chunk });
        remaining -= chunk;
      }
      if (remaining > 0) {
        throw new SellerPayoutError('INSUFFICIENT_AVAILABLE_BALANCE', 400);
      }

      const idempotenceKey = this.buildStableIdempotenceKey([
        'seller-finance-payout',
        sellerId,
        String(amountKopecks),
        String(Date.now()),
        crypto.randomUUID()
      ]);

      const created = await (tx as any).sellerPayout.create({
        data: {
          sellerId,
          orderId: allocations.length === 1 ? allocations[0].orderId : null,
          dealId: primaryDealId,
          payoutMethodId: payoutMethod.id,
          provider: PROVIDER,
          amountKopecks,
          currency: 'RUB',
          status: 'PROCESSING',
          description: payload.description?.trim() || 'Выплата продавцу',
          metadata: {
            source: 'finance',
            allocationCount: allocations.length
          },
          idempotenceKey,
          requestedAt: new Date()
        }
      });

      await (tx as any).sellerPayoutAllocation.createMany({
        data: allocations.map((item) => ({
          payoutId: created.id,
          orderId: item.orderId,
          amountKopecks: item.amountKopecks
        }))
      });

      return { payout: created, allocations, dealId: primaryDealId };
    }, {
      isolationLevel: 'Serializable'
    });

    let externalPayout: any;
    try {
      externalPayout = await yookassaService.createPayoutInDeal({
        orderId: reserved.allocations[0]?.orderId ?? reserved.payout.id,
        dealId: reserved.dealId,
        sellerAmountKopecks: amountKopecks,
        currency: 'RUB',
        payoutToken: payoutMethod.payoutToken,
        idempotenceKey: reserved.payout.idempotenceKey,
        description: payload.description?.trim() || 'Выплата продавцу',
        metadata: {
          payoutId: reserved.payout.id
        }
      });
    } catch (error) {
      await (prisma as any).sellerPayout.update({
        where: { id: reserved.payout.id },
        data: {
          status: 'FAILED',
          externalStatus: 'failed',
          canceledAt: new Date(),
          metadata: {
            ...(reserved.payout.metadata ?? {}),
            providerError: String(error)
          }
        }
      });
      throw new SellerPayoutError('PAYOUT_CREATE_FAILED', 502);
    }

    const mappedStatus = externalPayout.status === 'succeeded' ? 'SUCCEEDED' : externalPayout.status === 'canceled' ? 'CANCELED' : 'PENDING';
    const now = new Date();
    const updated = await (prisma as any).sellerPayout.update({
      where: { id: reserved.payout.id },
      data: {
        externalPayoutId: externalPayout.id,
        status: mappedStatus,
        externalStatus: externalPayout.status ?? null,
        succeededAt: mappedStatus === 'SUCCEEDED' ? now : null,
        canceledAt: mappedStatus === 'CANCELED' ? now : null,
        rawResponse: externalPayout
      }
    });

    return {
      payout: updated,
      allocations: reserved.allocations
    };
  },

  async listSellerPayouts(sellerId: string, options?: { sync?: boolean }) {
    const payouts = await (prisma as any).sellerPayout.findMany({
      where: { sellerId },
      orderBy: [{ createdAt: 'desc' }]
    });

    if (!options?.sync) return payouts;
    return Promise.all(payouts.map((payout: any) => this.syncPayoutStatus(sellerId, payout.id)));
  },

  async getSellerPayoutById(sellerId: string, payoutId: string, options?: { sync?: boolean }) {
    const payout = await (prisma as any).sellerPayout.findFirst({ where: { id: payoutId, sellerId } });
    if (!payout) throw new SellerPayoutError('PAYOUT_NOT_FOUND', 404);
    if (!options?.sync) return payout;
    return this.syncPayoutStatus(sellerId, payoutId);
  },

  async createPayoutForOrder(sellerId: string, orderId: string) {
    const order: any = await prisma.order.findFirst({
      where: { id: orderId, items: { some: { product: { sellerId } } } },
      include: { sellerPayouts: { orderBy: { createdAt: 'desc' } } as any }
    } as any);
    if (!order) throw new Error('ORDER_NOT_FOUND');
    const payment = order.paymentId
      ? await prisma.payment.findFirst({ where: { id: order.paymentId } })
      : await prisma.payment.findFirst({
          where: { orderId: order.id },
          orderBy: [{ createdAt: 'desc' }]
        });
    const resolvedDeal = resolveDealId(order, payment);
    const dealId = resolvedDeal.dealId;
    if (!dealId) {
      console.error('[PAYOUT][DEAL_NOT_FOUND]', {
        orderId: order.id,
        publicNumber: order.publicNumber,
        paymentId: order.paymentId ?? payment?.id ?? null,
        orderDealId: (order as any).yookassaDealId ?? null,
        payoutStatus: order.payoutStatus,
        orderStatus: order.status,
        orderPaymentStatus: order.paymentStatus,
        diagnostics: resolvedDeal.diagnostics
      });
      throw new SellerPayoutError('SELLER_PAYOUT_DEAL_NOT_FOUND', 400, { orderId, sellerId });
    }
    if (!order.yookassaDealId && dealId) {
      await prisma.order.update({
        where: { id: order.id },
        data: { yookassaDealId: dealId }
      });
      console.info('[PAYOUT][DEAL_BACKFILLED]', {
        orderId: order.id,
        publicNumber: order.publicNumber,
        dealId,
        source: resolvedDeal.source
      });
    }
    if (order.paymentStatus !== 'PAID') throw new Error('ORDER_NOT_PAID');
    if (PAYMENT_STATUS_REFUND_SET.has(String(order.paymentStatus))) throw new Error('ORDER_REFUND_IN_PROGRESS');

    const successful = (order.sellerPayouts ?? []).find((item: any) => item.status === 'SUCCEEDED');
    if (successful) throw new Error('PAYOUT_ALREADY_SUCCEEDED');

    const payoutMethod = await (prisma as any).sellerPayoutMethod.findFirst({
      where: { sellerId, isDefault: true, status: 'ACTIVE' }
    });
    if (!payoutMethod) throw new Error('DEFAULT_PAYOUT_METHOD_NOT_FOUND');

    const amountKopecks = order.sellerNetAmountKopecks ?? order.total;
    const idempotenceKey = `seller-payout:${order.id}:${payoutMethod.id}:${amountKopecks}`;
    const yookassaPayout = await yookassaService.createPayoutInDeal({
      orderId: order.id,
      dealId,
      sellerAmountKopecks: amountKopecks,
      currency: order.currency,
      payoutToken: payoutMethod.methodType === 'BANK_CARD' ? payoutMethod.payoutToken : undefined,
      payoutDestinationData:
        payoutMethod.methodType === 'YOOMONEY'
          ? { type: 'yoo_money', account_number: payoutMethod.yoomoneyAccountNumber }
          : undefined,
      idempotenceKey
    });

    const now = new Date();
    const mappedStatus = yookassaPayout.status === 'succeeded' ? 'SUCCEEDED' : yookassaPayout.status === 'canceled' ? 'CANCELED' : 'PENDING';
    const cancellationDetails = (yookassaPayout as any).cancellation_details ?? null;

    const payout = await (prisma as any).sellerPayout.create({
      data: {
        sellerId,
        orderId: order.id,
        dealId,
        payoutMethodId: payoutMethod.id,
        provider: PROVIDER,
        externalPayoutId: yookassaPayout.id,
        amountKopecks,
        currency: order.currency,
        status: mappedStatus,
        cancellationParty: cancellationDetails?.party ?? null,
        cancellationReason: cancellationDetails?.reason ?? null,
        description: `Payout for order ${order.publicNumber}`,
        idempotenceKey,
        requestedAt: now,
        succeededAt: mappedStatus === 'SUCCEEDED' ? now : null,
        canceledAt: mappedStatus === 'CANCELED' ? now : null,
        rawResponse: yookassaPayout
      }
    });

    await prisma.order.update({
      where: { id: order.id },
      data: {
        yookassaPayoutId: yookassaPayout.id,
        payoutStatus: mappedStatus === 'SUCCEEDED' ? 'PAID_OUT' : mappedStatus === 'CANCELED' ? 'PAYOUT_CANCELED' : 'PAYOUT_PENDING'
      }
    });

    if (mappedStatus === 'CANCELED' && ['rejected_by_payee', 'general_decline'].includes(String(cancellationDetails?.reason ?? ''))) {
      await (prisma as any).sellerPayoutMethod.update({ where: { id: payoutMethod.id }, data: { status: 'INVALID', isDefault: false } });
    }

    return payout;
  },

  async syncPayoutStatus(sellerId: string, payoutId: string) {
    const payout = await (prisma as any).sellerPayout.findFirst({
      where: { id: payoutId, sellerId }
    });
    if (!payout) throw new SellerPayoutError('PAYOUT_NOT_FOUND', 404);

    const external = await yookassaService.getPayout(payout.externalPayoutId);
    const mappedStatus = external.status === 'succeeded' ? 'SUCCEEDED' : external.status === 'canceled' ? 'CANCELED' : 'PENDING';
    const cancellationDetails = (external as any).cancellation_details ?? null;
    const updated = await (prisma as any).sellerPayout.update({
      where: { id: payout.id },
      data: {
        status: mappedStatus,
        externalStatus: external.status ?? null,
        succeededAt: mappedStatus === 'SUCCEEDED' ? new Date(String((external as any).succeeded_at ?? new Date().toISOString())) : null,
        canceledAt: mappedStatus === 'CANCELED' ? new Date() : null,
        cancellationParty: cancellationDetails?.party ?? null,
        cancellationReason: cancellationDetails?.reason ?? null,
        rawResponse: external
      }
    });

    if (payout.orderId) {
      await prisma.order.update({
        where: { id: payout.orderId },
        data: {
          payoutStatus: mappedStatus === 'SUCCEEDED' ? 'PAID_OUT' : mappedStatus === 'CANCELED' ? 'PAYOUT_CANCELED' : 'PAYOUT_PENDING'
        }
      });
    }

    return updated;
  },

  async buildFinanceView(sellerId: string, search?: string) {
    const searchDigits = search?.replace(/\D/g, '') ?? '';
    const orders = await prisma.order.findMany({
      where: {
        items: { some: { product: { sellerId } } },
        ...(search
          ? {
              OR: [
                { publicNumber: { contains: search, mode: 'insensitive' } },
                ...(searchDigits ? [{ publicNumber: { endsWith: searchDigits } }] : [])
              ]
            }
          : {})
      },
      select: {
        id: true,
        publicNumber: true,
        total: true,
        grossAmountKopecks: true,
        serviceFeeKopecks: true,
        platformFeeKopecks: true,
        acquiringFeeKopecks: true,
        sellerNetAmountKopecks: true,
        currency: true,
        payoutStatus: true,
        paymentStatus: true,
        status: true,
        createdAt: true,
        paidAt: true,
        refunds: { select: { id: true, amount: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
        sellerPayouts: {
          select: {
            id: true,
            status: true,
            amountKopecks: true,
            createdAt: true,
            succeededAt: true,
            payoutMethod: { select: { methodType: true, maskedLabel: true, cardLast4: true } }
          },
          orderBy: { createdAt: 'desc' }
        } as any
      },
      orderBy: { createdAt: 'desc' }
    } as any);

    const summary = { awaitingPayoutKopecks: 0, frozenKopecks: 0, paidOutKopecks: 0, refundedKopecks: 0, blockedKopecks: 0 };
    const payoutQueue: any[] = [];
    const adjustments: any[] = [];
    const payoutHistory: any[] = [];
    const seenAdjustments = new Set<string>();
    const orderIds = orders.map((order: any) => order.id);
    const allocations = orderIds.length
      ? await (prisma as any).sellerPayoutAllocation.findMany({
          where: {
            orderId: { in: orderIds },
            payout: { status: { in: [...ALLOCATION_CONSUMING_PAYOUT_STATUSES] } }
          },
          select: {
            orderId: true,
            amountKopecks: true,
            payout: { select: { status: true } }
          }
        })
      : [];
    const payoutConsumptionByOrder = new Map<string, { reserved: number; paidOut: number }>();
    for (const allocation of allocations) {
      const current = payoutConsumptionByOrder.get(allocation.orderId) ?? { reserved: 0, paidOut: 0 };
      const amount = Number(allocation.amountKopecks ?? 0);
      if (String(allocation.payout?.status ?? '').toUpperCase() === 'SUCCEEDED') current.paidOut += amount;
      else current.reserved += amount;
      payoutConsumptionByOrder.set(allocation.orderId, current);
    }

    for (const order of orders as any[]) {
      const gross = order.grossAmountKopecks ?? order.total;
      const platformFee = order.platformFeeKopecks ?? 0;
      const providerFee = order.acquiringFeeKopecks ?? 0;
      const serviceFee = order.serviceFeeKopecks ?? platformFee + providerFee;
      const net = order.sellerNetAmountKopecks ?? Math.max(0, gross - serviceFee);
      const payoutConsumption = payoutConsumptionByOrder.get(order.id) ?? { reserved: 0, paidOut: 0 };
      const availableForPayout = Math.max(0, net - payoutConsumption.paidOut - payoutConsumption.reserved);
      const payoutStatus = normalizePayoutStatus(order.payoutStatus);
      const paymentStatus = normalizePayoutStatus(order.paymentStatus);

      if (PAYMENT_STATUS_REFUND_SET.has(paymentStatus)) summary.refundedKopecks += net;
      else if (SUCCESS_PAYOUT_STATUSES.has(payoutStatus)) summary.paidOutKopecks += net;
      else if (BLOCKED_PAYOUT_STATUSES.has(payoutStatus)) summary.blockedKopecks += net;
      else if (AWAITING_PAYOUT_STATUSES.has(payoutStatus)) {
        summary.awaitingPayoutKopecks += availableForPayout;
        summary.frozenKopecks += payoutConsumption.reserved;
        summary.paidOutKopecks += payoutConsumption.paidOut;
      } else if (FROZEN_PAYOUT_STATUSES.has(payoutStatus) || PAYOUT_PENDING_STATUSES.has(payoutStatus)) {
        summary.frozenKopecks += availableForPayout + payoutConsumption.reserved;
        summary.paidOutKopecks += payoutConsumption.paidOut;
      } else {
        summary.frozenKopecks += availableForPayout + payoutConsumption.reserved;
        summary.paidOutKopecks += payoutConsumption.paidOut;
      }

      const queueAllowed = paymentStatus === 'PAID' && !SUCCESS_PAYOUT_STATUSES.has(payoutStatus) && !BLOCKED_PAYOUT_STATUSES.has(payoutStatus);
      if (queueAllowed && availableForPayout > 0) {
        const eligibleForPayoutAt = order.paidAt ? new Date(order.paidAt.getTime() + 7 * 24 * 60 * 60 * 1000) : null;
        payoutQueue.push({
          orderId: order.id,
          publicNumber: order.publicNumber,
          eligibleForPayoutAt: eligibleForPayoutAt?.toISOString() ?? null,
          grossAmountKopecks: gross,
          grossAmountRubles: money.toRublesString(gross),
          serviceFeeKopecks: serviceFee,
          serviceFeeRubles: money.toRublesString(serviceFee),
          platformFeeKopecks: platformFee,
          platformFeeRubles: money.toRublesString(platformFee),
          providerFeeKopecks: providerFee,
          providerFeeRubles: money.toRublesString(providerFee),
          sellerNetAmountKopecks: availableForPayout,
          sellerNetAmountRubles: money.toRublesString(availableForPayout),
          payoutStatus: payoutStatus || null,
          orderStatus: order.status,
          paymentStatus: order.paymentStatus
        });
      }

      if (paymentStatus === 'REFUND_PENDING' || paymentStatus === 'REFUNDED') {
        const key = `${order.id}:${paymentStatus}`;
        if (!seenAdjustments.has(key)) {
          seenAdjustments.add(key);
          adjustments.push({
            orderId: order.id,
            publicNumber: order.publicNumber,
            type: 'REFUND',
            createdAt: order.paidAt?.toISOString() ?? order.createdAt.toISOString(),
            amountKopecks: net,
            amountRubles: money.toRublesString(net),
            status: paymentStatus,
            description: 'Возврат покупателю'
          });
        }
      }

      if (['PAYOUT_CANCELED', 'FAILED', 'BLOCKED'].includes(payoutStatus)) {
        const key = `${order.id}:${payoutStatus}`;
        if (!seenAdjustments.has(key)) {
          seenAdjustments.add(key);
          adjustments.push({
            orderId: order.id,
            publicNumber: order.publicNumber,
            type: payoutStatus === 'BLOCKED' ? 'BLOCKED' : 'PAYOUT_CANCELED',
            createdAt: order.createdAt.toISOString(),
            amountKopecks: net,
            amountRubles: money.toRublesString(net),
            status: payoutStatus,
            description: payoutStatus === 'BLOCKED' ? 'Выплата заблокирована' : 'Выплата отменена'
          });
        }
      }

      for (const payout of order.sellerPayouts ?? []) {
        if (payout.status !== 'SUCCEEDED') continue;
        payoutHistory.push({
          payoutId: payout.id,
          orderId: order.id,
          publicNumber: order.publicNumber,
          createdAt: payout.createdAt.toISOString(),
          succeededAt: payout.succeededAt?.toISOString() ?? payout.createdAt.toISOString(),
          amountKopecks: payout.amountKopecks,
          amountRubles: money.toRublesString(payout.amountKopecks),
          grossAmountKopecks: gross,
          grossAmountRubles: money.toRublesString(gross),
          serviceFeeKopecks: serviceFee,
          serviceFeeRubles: money.toRublesString(serviceFee),
          platformFeeKopecks: platformFee,
          platformFeeRubles: money.toRublesString(platformFee),
          providerFeeKopecks: providerFee,
          providerFeeRubles: money.toRublesString(providerFee),
          sellerNetAmountKopecks: net,
          sellerNetAmountRubles: money.toRublesString(net),
          payoutMethodSummary: payout.payoutMethod?.maskedLabel ?? payout.payoutMethod?.methodType ?? null,
          status: 'SUCCEEDED'
        });
      }
    }

    const nextPayoutAmountKopecks = payoutQueue.reduce((acc, item) => acc + item.sellerNetAmountKopecks, 0);
    const payoutMethods = await this.listPayoutMethods(sellerId);

    return {
      summary: {
        ...summary,
        awaitingPayoutRubles: money.toRublesString(summary.awaitingPayoutKopecks),
        frozenRubles: money.toRublesString(summary.frozenKopecks),
        paidOutRubles: money.toRublesString(summary.paidOutKopecks),
        refundedRubles: money.toRublesString(summary.refundedKopecks),
        blockedRubles: money.toRublesString(summary.blockedKopecks)
      },
      nextPayout: {
        scheduledAt: null,
        amountKopecks: nextPayoutAmountKopecks,
        amountRubles: money.toRublesString(nextPayoutAmountKopecks),
        orderCount: payoutQueue.length,
        payoutScheduleType: 'MANUAL' as const
      },
      payoutQueue,
      adjustments,
      payoutHistory,
      payoutMethodsSummary: {
        total: payoutMethods.length,
        active: payoutMethods.filter((item) => item.status === 'ACTIVE').length,
        defaultMethodId: payoutMethods.find((item) => item.isDefault)?.id ?? null
      }
    };
  },

  buildStableIdempotenceKey(parts: string[]) {
    return crypto.createHash('sha256').update(parts.join(':')).digest('hex');
  },

  isSellerPayoutError(error: unknown): error is SellerPayoutError {
    return error instanceof SellerPayoutError;
  }
};
