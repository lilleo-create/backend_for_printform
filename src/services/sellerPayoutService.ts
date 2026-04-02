import crypto from 'node:crypto';
import { prisma } from '../lib/prisma';
import { money } from '../utils/money';
import { yookassaService } from './yookassaService';

const PROVIDER = 'YOOKASSA';

const PAYMENT_STATUS_REFUND_SET = new Set(['REFUND_PENDING', 'REFUNDED']);
const BLOCKED_PAYOUT_STATUSES = new Set(['BLOCKED', 'FAILED', 'PAYOUT_CANCELED']);
const AWAITING_PAYOUT_STATUSES = new Set(['AWAITING_PAYOUT', 'RELEASED']);
const FROZEN_PAYOUT_STATUSES = new Set(['HOLD']);
const PAYOUT_PENDING_STATUSES = new Set(['PAYOUT_PENDING', 'PROCESSING']);
const SUCCESS_PAYOUT_STATUSES = new Set(['PAID', 'PAID_OUT']);
const MIN_PAYOUT_AMOUNT_KOPECKS = 100;
const MAX_PAYOUT_AMOUNT_KOPECKS = 15_000_000;

const normalizePayoutStatus = (status?: string | null) => String(status ?? '').toUpperCase();

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
    const methodData = {
      sellerId,
      provider: PROVIDER,
      methodType: 'BANK_CARD',
      payoutToken: payload.payoutToken,
      cardFirst6: payload.first6 ?? null,
      cardLast4: payload.last4,
      cardType: payload.cardType ?? null,
      cardIssuerCountry: payload.issuerCountry ?? null,
      cardIssuerName: payload.issuerName ?? null,
      maskedLabel: buildMethodMaskedLabel({
        methodType: 'BANK_CARD',
        cardType: payload.cardType ?? null,
        cardLast4: payload.last4
      }),
      status: 'ACTIVE'
    } as const;

    await prisma.$transaction(async (tx) => {
      const existing = await (tx as any).sellerPayoutMethod.findFirst({
        where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD' },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
      });

      if (existing) {
        await (tx as any).sellerPayoutMethod.updateMany({
          where: { sellerId, isDefault: true },
          data: { isDefault: false }
        });
        await (tx as any).sellerPayoutMethod.update({
          where: { id: existing.id },
          data: { ...methodData, isDefault: true }
        });
        await (tx as any).sellerPayoutMethod.updateMany({
          where: { sellerId, methodType: 'BANK_CARD', NOT: { id: existing.id } },
          data: { status: 'REVOKED', isDefault: false }
        });
      } else {
        await (tx as any).sellerPayoutMethod.create({
          data: {
            ...methodData,
            isDefault: true
          }
        });
      }
    });

    return {
      cardType: payload.cardType ?? null,
      first6: payload.first6 ?? null,
      last4: payload.last4,
      issuerCountry: payload.issuerCountry ?? null,
      issuerName: payload.issuerName ?? null
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

  async calculateAvailableBalanceKopecks(sellerId: string) {
    const orders = await prisma.order.findMany({
      where: {
        items: { some: { product: { sellerId } } },
        paymentStatus: 'PAID',
        payoutStatus: { in: ['RELEASED', 'AWAITING_PAYOUT'] }
      },
      select: {
        id: true,
        sellerNetAmountKopecks: true,
        total: true
      }
    });

    const pendingPayouts = await (prisma as any).sellerPayout.findMany({
      where: { sellerId, status: { in: ['PENDING', 'WAITING_FOR_CAPTURE', 'PROCESSING'] } },
      select: { amountKopecks: true }
    });

    const readyAmount = orders.reduce((acc, order) => acc + Number(order.sellerNetAmountKopecks ?? order.total ?? 0), 0);
    const reservedAmount = pendingPayouts.reduce((acc: number, payout: any) => acc + Number(payout.amountKopecks ?? 0), 0);
    return Math.max(0, readyAmount - reservedAmount);
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

    const availableKopecks = await this.calculateAvailableBalanceKopecks(sellerId);
    if (amountKopecks > availableKopecks) {
      throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_EXCEEDS_AVAILABLE', 400, {
        requested: money.toRublesString(amountKopecks),
        available: money.toRublesString(availableKopecks)
      });
    }

    const mode = payload.mode === 'test' ? 'test' : 'live';
    const orderForDeal = payload.orderId
      ? await prisma.order.findFirst({
          where: { id: payload.orderId, items: { some: { product: { sellerId } } }, yookassaDealId: { not: null } },
          select: { id: true, publicNumber: true, yookassaDealId: true }
        })
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
    const dealId = orderForDeal?.yookassaDealId ?? (mode === 'test' ? fallbackTestDealId : null);
    if (!dealId) {
      throw new SellerPayoutError('SELLER_PAYOUT_DEAL_NOT_FOUND', 400, {
        mode,
        orderId: payload.orderId ?? null,
        hint: mode === 'test' ? 'Set YOOKASSA_TEST_DEAL_ID or create paid order with yookassaDealId' : null
      });
    }

    const referenceOrderId = orderForDeal?.id ?? payload.orderId ?? `seller-${sellerId}-test`;

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
        orderId: orderForDeal?.id ?? null,
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
          orderId: orderForDeal?.id ?? null,
          orderPublicNumber: orderForDeal?.publicNumber ?? null,
          mode
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
    if (!order.yookassaDealId) throw new Error('SAFE_DEAL_REQUIRED');
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
      dealId: order.yookassaDealId,
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
        dealId: order.yookassaDealId,
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
        platformFeeKopecks: true,
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

    for (const order of orders as any[]) {
      const gross = order.grossAmountKopecks ?? order.total;
      const fee = order.platformFeeKopecks ?? 0;
      const net = order.sellerNetAmountKopecks ?? Math.max(0, gross - fee);
      const payoutStatus = normalizePayoutStatus(order.payoutStatus);
      const paymentStatus = normalizePayoutStatus(order.paymentStatus);

      if (PAYMENT_STATUS_REFUND_SET.has(paymentStatus)) summary.refundedKopecks += net;
      else if (SUCCESS_PAYOUT_STATUSES.has(payoutStatus)) summary.paidOutKopecks += net;
      else if (BLOCKED_PAYOUT_STATUSES.has(payoutStatus)) summary.blockedKopecks += net;
      else if (AWAITING_PAYOUT_STATUSES.has(payoutStatus)) summary.awaitingPayoutKopecks += net;
      else if (FROZEN_PAYOUT_STATUSES.has(payoutStatus) || PAYOUT_PENDING_STATUSES.has(payoutStatus)) summary.frozenKopecks += net;
      else summary.frozenKopecks += net;

      const queueAllowed = paymentStatus === 'PAID' && !SUCCESS_PAYOUT_STATUSES.has(payoutStatus) && !BLOCKED_PAYOUT_STATUSES.has(payoutStatus);
      if (queueAllowed) {
        const eligibleForPayoutAt = order.paidAt ? new Date(order.paidAt.getTime() + 7 * 24 * 60 * 60 * 1000) : null;
        payoutQueue.push({
          orderId: order.id,
          publicNumber: order.publicNumber,
          eligibleForPayoutAt: eligibleForPayoutAt?.toISOString() ?? null,
          grossAmountKopecks: gross,
          grossAmountRubles: money.toRublesString(gross),
          platformFeeKopecks: fee,
          platformFeeRubles: money.toRublesString(fee),
          sellerNetAmountKopecks: net,
          sellerNetAmountRubles: money.toRublesString(net),
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
          platformFeeKopecks: fee,
          platformFeeRubles: money.toRublesString(fee),
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
