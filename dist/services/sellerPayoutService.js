"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sellerPayoutService = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const prisma_1 = require("../lib/prisma");
const money_1 = require("../utils/money");
const env_1 = require("../config/env");
const yookassaService_1 = require("./yookassaService");
const PROVIDER = 'YOOKASSA';
const PAYMENT_STATUS_REFUND_SET = new Set(['REFUND_PENDING', 'REFUNDED']);
const BLOCKED_PAYOUT_STATUSES = new Set(['BLOCKED', 'FAILED', 'PAYOUT_CANCELED']);
const AWAITING_PAYOUT_STATUSES = new Set(['AWAITING_PAYOUT', 'RELEASED']);
const FROZEN_PAYOUT_STATUSES = new Set(['HOLD']);
const PAYOUT_PENDING_STATUSES = new Set(['PAYOUT_PENDING', 'PROCESSING']);
const SUCCESS_PAYOUT_STATUSES = new Set(['PAID', 'PAID_OUT']);
const normalizePayoutStatus = (status) => String(status ?? '').toUpperCase();
const buildMethodMaskedLabel = (method) => {
    if (method.methodType === 'BANK_CARD') {
        const cardType = method.cardType ?? 'Card';
        const last4 = method.cardLast4 ?? '••••';
        return `${cardType} •••• ${last4}`;
    }
    const wallet = method.yoomoneyAccountNumber ?? '';
    const last4 = wallet.slice(-4).padStart(4, '•');
    return `YooMoney •••• ${last4}`;
};
exports.sellerPayoutService = {
    isSafeDealWidgetConfigured() {
        const hasAccountId = Boolean(this.getSafeDealShopId());
        const hasCredentials = Boolean(env_1.env.yookassaShopId && env_1.env.yookassaSecretKey);
        return hasAccountId && (env_1.env.yookassaSafeDealEnabled || hasCredentials);
    },
    getSafeDealShopId() {
        const accountId = env_1.env.yookassaSafeDealAccountId || env_1.env.yookassaShopId;
        return accountId ? String(accountId).trim() : null;
    },
    async getYookassaPayoutDetails(sellerId) {
        const method = await prisma_1.prisma.sellerPayoutMethod.findFirst({
            where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD', status: { in: ['ACTIVE', 'INVALID'] } },
            orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
        });
        if (!method)
            return null;
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
    async getYookassaWidgetConfig(sellerId) {
        const payoutDetails = await this.getYookassaPayoutDetails(sellerId);
        const accountId = this.getSafeDealShopId();
        return {
            enabled: this.isSafeDealWidgetConfigured(),
            type: 'safedeal',
            accountId,
            hasSavedCard: Boolean(payoutDetails?.hasSavedCard),
            card: payoutDetails?.card ?? null
        };
    },
    async saveYookassaCardFromWidget(sellerId, payload) {
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
        };
        await prisma_1.prisma.$transaction(async (tx) => {
            const existing = await tx.sellerPayoutMethod.findFirst({
                where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD' },
                orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
            });
            if (existing) {
                await tx.sellerPayoutMethod.updateMany({
                    where: { sellerId, isDefault: true },
                    data: { isDefault: false }
                });
                await tx.sellerPayoutMethod.update({
                    where: { id: existing.id },
                    data: { ...methodData, isDefault: true }
                });
                await tx.sellerPayoutMethod.updateMany({
                    where: { sellerId, methodType: 'BANK_CARD', NOT: { id: existing.id } },
                    data: { status: 'REVOKED', isDefault: false }
                });
            }
            else {
                await tx.sellerPayoutMethod.create({
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
    async listPayoutMethods(sellerId) {
        const methods = await prisma_1.prisma.sellerPayoutMethod.findMany({
            where: { sellerId },
            orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }]
        });
        return methods.map((method) => ({
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
    async createPayoutMethod(sellerId, payload) {
        const isDefault = Boolean(payload.isDefault);
        const methodType = String(payload.methodType);
        const maskedLabel = buildMethodMaskedLabel({
            methodType,
            cardType: payload.cardType ?? null,
            cardLast4: payload.cardLast4 ?? null,
            yoomoneyAccountNumber: payload.yoomoneyAccountNumber ?? null
        });
        return prisma_1.prisma.$transaction(async (tx) => {
            if (isDefault) {
                await tx.sellerPayoutMethod.updateMany({
                    where: { sellerId, isDefault: true },
                    data: { isDefault: false }
                });
            }
            const created = await tx.sellerPayoutMethod.create({
                data: {
                    sellerId,
                    provider: PROVIDER,
                    methodType,
                    payoutToken: payload.payoutToken ?? null,
                    cardFirst6: payload.cardFirst6 ?? null,
                    cardLast4: payload.cardLast4 ?? null,
                    cardType: payload.cardType ?? null,
                    cardIssuerCountry: payload.cardIssuerCountry ?? null,
                    cardIssuerName: payload.cardIssuerName ?? null,
                    yoomoneyAccountNumber: payload.yoomoneyAccountNumber ?? null,
                    maskedLabel,
                    status: 'ACTIVE',
                    isDefault,
                    meta: payload.meta ?? null
                }
            });
            if (!isDefault) {
                const hasDefault = await tx.sellerPayoutMethod.findFirst({ where: { sellerId, isDefault: true } });
                if (!hasDefault) {
                    await tx.sellerPayoutMethod.update({ where: { id: created.id }, data: { isDefault: true } });
                    created.isDefault = true;
                }
            }
            return created;
        });
    },
    async setDefaultMethod(sellerId, methodId) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const method = await tx.sellerPayoutMethod.findFirst({ where: { id: methodId, sellerId } });
            if (!method)
                return null;
            await tx.sellerPayoutMethod.updateMany({
                where: { sellerId, isDefault: true },
                data: { isDefault: false }
            });
            return tx.sellerPayoutMethod.update({
                where: { id: methodId },
                data: { isDefault: true, status: method.status === 'REVOKED' ? 'ACTIVE' : method.status }
            });
        });
    },
    async revokeMethod(sellerId, methodId) {
        return prisma_1.prisma.$transaction(async (tx) => {
            const method = await tx.sellerPayoutMethod.findFirst({ where: { id: methodId, sellerId } });
            if (!method)
                return null;
            await tx.sellerPayoutMethod.update({
                where: { id: methodId },
                data: { status: 'REVOKED', isDefault: false }
            });
            if (method.isDefault) {
                const replacement = await tx.sellerPayoutMethod.findFirst({
                    where: { sellerId, status: 'ACTIVE', NOT: { id: methodId } },
                    orderBy: { createdAt: 'asc' }
                });
                if (replacement) {
                    await tx.sellerPayoutMethod.update({ where: { id: replacement.id }, data: { isDefault: true } });
                }
            }
            return { ...method, status: 'REVOKED', isDefault: false };
        });
    },
    async createPayoutForOrder(sellerId, orderId) {
        const order = await prisma_1.prisma.order.findFirst({
            where: { id: orderId, items: { some: { product: { sellerId } } } },
            include: { sellerPayouts: { orderBy: { createdAt: 'desc' } } }
        });
        if (!order)
            throw new Error('ORDER_NOT_FOUND');
        if (!order.yookassaDealId)
            throw new Error('SAFE_DEAL_REQUIRED');
        if (order.paymentStatus !== 'PAID')
            throw new Error('ORDER_NOT_PAID');
        if (PAYMENT_STATUS_REFUND_SET.has(String(order.paymentStatus)))
            throw new Error('ORDER_REFUND_IN_PROGRESS');
        const successful = (order.sellerPayouts ?? []).find((item) => item.status === 'SUCCEEDED');
        if (successful)
            throw new Error('PAYOUT_ALREADY_SUCCEEDED');
        const payoutMethod = await prisma_1.prisma.sellerPayoutMethod.findFirst({
            where: { sellerId, isDefault: true, status: 'ACTIVE' }
        });
        if (!payoutMethod)
            throw new Error('DEFAULT_PAYOUT_METHOD_NOT_FOUND');
        const amountKopecks = order.sellerNetAmountKopecks ?? order.total;
        const idempotenceKey = `seller-payout:${order.id}:${payoutMethod.id}:${amountKopecks}`;
        const yookassaPayout = await yookassaService_1.yookassaService.createPayoutInDeal({
            orderId: order.id,
            dealId: order.yookassaDealId,
            sellerAmountKopecks: amountKopecks,
            currency: order.currency,
            payoutToken: payoutMethod.methodType === 'BANK_CARD' ? payoutMethod.payoutToken : undefined,
            payoutDestinationData: payoutMethod.methodType === 'YOOMONEY'
                ? { type: 'yoo_money', account_number: payoutMethod.yoomoneyAccountNumber }
                : undefined,
            idempotenceKey
        });
        const now = new Date();
        const mappedStatus = yookassaPayout.status === 'succeeded' ? 'SUCCEEDED' : yookassaPayout.status === 'canceled' ? 'CANCELED' : 'PENDING';
        const cancellationDetails = yookassaPayout.cancellation_details ?? null;
        const payout = await prisma_1.prisma.sellerPayout.create({
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
        await prisma_1.prisma.order.update({
            where: { id: order.id },
            data: {
                yookassaPayoutId: yookassaPayout.id,
                payoutStatus: mappedStatus === 'SUCCEEDED' ? 'PAID_OUT' : mappedStatus === 'CANCELED' ? 'PAYOUT_CANCELED' : 'PAYOUT_PENDING'
            }
        });
        if (mappedStatus === 'CANCELED' && ['rejected_by_payee', 'general_decline'].includes(String(cancellationDetails?.reason ?? ''))) {
            await prisma_1.prisma.sellerPayoutMethod.update({ where: { id: payoutMethod.id }, data: { status: 'INVALID', isDefault: false } });
        }
        return payout;
    },
    async syncPayoutStatus(sellerId, payoutId) {
        const payout = await prisma_1.prisma.sellerPayout.findFirst({
            where: { id: payoutId, sellerId }
        });
        if (!payout)
            throw new Error('PAYOUT_NOT_FOUND');
        const external = await yookassaService_1.yookassaService.getPayout(payout.externalPayoutId);
        const mappedStatus = external.status === 'succeeded' ? 'SUCCEEDED' : external.status === 'canceled' ? 'CANCELED' : 'PENDING';
        const cancellationDetails = external.cancellation_details ?? null;
        const updated = await prisma_1.prisma.sellerPayout.update({
            where: { id: payout.id },
            data: {
                status: mappedStatus,
                succeededAt: mappedStatus === 'SUCCEEDED' ? new Date(String(external.succeeded_at ?? new Date().toISOString())) : null,
                canceledAt: mappedStatus === 'CANCELED' ? new Date() : null,
                cancellationParty: cancellationDetails?.party ?? null,
                cancellationReason: cancellationDetails?.reason ?? null,
                rawResponse: external
            }
        });
        await prisma_1.prisma.order.update({
            where: { id: payout.orderId },
            data: {
                payoutStatus: mappedStatus === 'SUCCEEDED' ? 'PAID_OUT' : mappedStatus === 'CANCELED' ? 'PAYOUT_CANCELED' : 'PAYOUT_PENDING'
            }
        });
        return updated;
    },
    async buildFinanceView(sellerId, search) {
        const searchDigits = search?.replace(/\D/g, '') ?? '';
        const orders = await prisma_1.prisma.order.findMany({
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
                }
            },
            orderBy: { createdAt: 'desc' }
        });
        const summary = { awaitingPayoutKopecks: 0, frozenKopecks: 0, paidOutKopecks: 0, refundedKopecks: 0, blockedKopecks: 0 };
        const payoutQueue = [];
        const adjustments = [];
        const payoutHistory = [];
        const seenAdjustments = new Set();
        for (const order of orders) {
            const gross = order.grossAmountKopecks ?? order.total;
            const fee = order.platformFeeKopecks ?? 0;
            const net = order.sellerNetAmountKopecks ?? Math.max(0, gross - fee);
            const payoutStatus = normalizePayoutStatus(order.payoutStatus);
            const paymentStatus = normalizePayoutStatus(order.paymentStatus);
            if (PAYMENT_STATUS_REFUND_SET.has(paymentStatus))
                summary.refundedKopecks += net;
            else if (SUCCESS_PAYOUT_STATUSES.has(payoutStatus))
                summary.paidOutKopecks += net;
            else if (BLOCKED_PAYOUT_STATUSES.has(payoutStatus))
                summary.blockedKopecks += net;
            else if (AWAITING_PAYOUT_STATUSES.has(payoutStatus))
                summary.awaitingPayoutKopecks += net;
            else if (FROZEN_PAYOUT_STATUSES.has(payoutStatus) || PAYOUT_PENDING_STATUSES.has(payoutStatus))
                summary.frozenKopecks += net;
            else
                summary.frozenKopecks += net;
            const queueAllowed = paymentStatus === 'PAID' && !SUCCESS_PAYOUT_STATUSES.has(payoutStatus) && !BLOCKED_PAYOUT_STATUSES.has(payoutStatus);
            if (queueAllowed) {
                const eligibleForPayoutAt = order.paidAt ? new Date(order.paidAt.getTime() + 7 * 24 * 60 * 60 * 1000) : null;
                payoutQueue.push({
                    orderId: order.id,
                    publicNumber: order.publicNumber,
                    eligibleForPayoutAt: eligibleForPayoutAt?.toISOString() ?? null,
                    grossAmountKopecks: gross,
                    grossAmountRubles: money_1.money.toRublesString(gross),
                    platformFeeKopecks: fee,
                    platformFeeRubles: money_1.money.toRublesString(fee),
                    sellerNetAmountKopecks: net,
                    sellerNetAmountRubles: money_1.money.toRublesString(net),
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
                        amountRubles: money_1.money.toRublesString(net),
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
                        amountRubles: money_1.money.toRublesString(net),
                        status: payoutStatus,
                        description: payoutStatus === 'BLOCKED' ? 'Выплата заблокирована' : 'Выплата отменена'
                    });
                }
            }
            for (const payout of order.sellerPayouts ?? []) {
                if (payout.status !== 'SUCCEEDED')
                    continue;
                payoutHistory.push({
                    payoutId: payout.id,
                    orderId: order.id,
                    publicNumber: order.publicNumber,
                    createdAt: payout.createdAt.toISOString(),
                    succeededAt: payout.succeededAt?.toISOString() ?? payout.createdAt.toISOString(),
                    amountKopecks: payout.amountKopecks,
                    amountRubles: money_1.money.toRublesString(payout.amountKopecks),
                    grossAmountKopecks: gross,
                    grossAmountRubles: money_1.money.toRublesString(gross),
                    platformFeeKopecks: fee,
                    platformFeeRubles: money_1.money.toRublesString(fee),
                    sellerNetAmountKopecks: net,
                    sellerNetAmountRubles: money_1.money.toRublesString(net),
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
                awaitingPayoutRubles: money_1.money.toRublesString(summary.awaitingPayoutKopecks),
                frozenRubles: money_1.money.toRublesString(summary.frozenKopecks),
                paidOutRubles: money_1.money.toRublesString(summary.paidOutKopecks),
                refundedRubles: money_1.money.toRublesString(summary.refundedKopecks),
                blockedRubles: money_1.money.toRublesString(summary.blockedKopecks)
            },
            nextPayout: {
                scheduledAt: null,
                amountKopecks: nextPayoutAmountKopecks,
                amountRubles: money_1.money.toRublesString(nextPayoutAmountKopecks),
                orderCount: payoutQueue.length,
                payoutScheduleType: 'MANUAL'
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
    buildStableIdempotenceKey(parts) {
        return node_crypto_1.default.createHash('sha256').update(parts.join(':')).digest('hex');
    }
};
