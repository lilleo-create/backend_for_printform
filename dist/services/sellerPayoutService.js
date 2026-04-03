"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.sellerPayoutService = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const axios_1 = __importDefault(require("axios"));
const prisma_1 = require("../lib/prisma");
const money_1 = require("../utils/money");
const yookassaService_1 = require("./yookassaService");
const PROVIDER = 'YOOKASSA';
const PAYMENT_STATUS_REFUND_SET = new Set(['REFUND_PENDING', 'REFUNDED']);
const BLOCKED_PAYOUT_STATUSES = new Set(['BLOCKED', 'FAILED', 'PAYOUT_CANCELED']);
const AWAITING_PAYOUT_STATUSES = new Set(['AWAITING_PAYOUT', 'RELEASED']);
const FROZEN_PAYOUT_STATUSES = new Set(['HOLD']);
const PAYOUT_PENDING_STATUSES = new Set(['PAYOUT_PENDING', 'PROCESSING']);
const SUCCESS_PAYOUT_STATUSES = new Set(['PAID', 'PAID_OUT']);
const ALLOCATION_CONSUMING_PAYOUT_STATUSES = ['PENDING', 'WAITING_FOR_CAPTURE', 'PROCESSING', 'SUCCEEDED'];
const ALLOCATION_PENDING_PAYOUT_STATUSES = ['PENDING', 'WAITING_FOR_CAPTURE', 'PROCESSING'];
const ACTIVE_PAYOUT_STATUSES = ['PENDING', 'WAITING_FOR_CAPTURE', 'PROCESSING'];
const MIN_PAYOUT_AMOUNT_KOPECKS = 100;
const MAX_PAYOUT_AMOUNT_KOPECKS = 15000000;
const normalizePayoutStatus = (status) => String(status ?? '').toUpperCase();
const DEFAULT_TEST_PAYOUT_DESCRIPTION = 'Тестовая выплата продавцу';
const asObject = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
const toNonEmptyString = (value) => {
    if (typeof value !== 'string')
        return null;
    const trimmed = value.trim();
    return trimmed || null;
};
const extractDealIdFromPayloadJson = (payloadJson) => {
    const payload = asObject(payloadJson);
    if (!payload)
        return null;
    const objectNode = asObject(payload.object);
    const metadata = asObject(payload.metadata) ?? asObject(objectNode?.metadata);
    const deal = asObject(payload.deal) ?? asObject(objectNode?.deal);
    const directDealId = toNonEmptyString(payload.dealId) ?? toNonEmptyString(payload.yookassaDealId);
    if (directDealId)
        return directDealId;
    const metadataDealId = toNonEmptyString(metadata?.dealId);
    if (metadataDealId)
        return metadataDealId;
    const dealObjectId = toNonEmptyString(deal?.id);
    if (dealObjectId)
        return dealObjectId;
    return null;
};
function resolveDealId(order, payment) {
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
    constructor(code, httpStatus, details) {
        super(code);
        this.code = code;
        this.httpStatus = httpStatus;
        this.details = details;
    }
}
const ORDER_TERMINAL_BLOCKED_STATUSES = new Set(['CANCELLED', 'CANCELED', 'RETURNED']);
const ORDER_COMPLETED_STATUSES = new Set(['DELIVERED', 'COMPLETED']);
const isOrderSafeDeal = (order, dealId) => {
    if (dealId)
        return true;
    return Boolean(order?.paymentId);
};
const buildOrderPayoutDescription = (publicNumber) => `Выплата по заказу №${publicNumber ?? '-'}`;
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
    normalizePayoutAmountKopecks(amount) {
        if (typeof amount === 'number') {
            if (!Number.isFinite(amount))
                throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, { message: 'Некорректная сумма выплаты.' });
            return money_1.money.toKopecks(amount);
        }
        const normalized = amount.trim().replace(',', '.');
        if (!normalized)
            throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, { message: 'Некорректная сумма выплаты.' });
        const numeric = Number(normalized);
        if (!Number.isFinite(numeric))
            throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, { message: 'Некорректная сумма выплаты.' });
        return money_1.money.toKopecks(numeric);
    },
    async resolveDealIdForPayout(sellerId, requestedDealId) {
        if (requestedDealId?.trim())
            return requestedDealId.trim();
        const orderWithDeal = await prisma_1.prisma.order.findFirst({
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
    async resolveOrderDealIdForPayout(params) {
        const db = params.tx ?? prisma_1.prisma;
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
        if (!order)
            throw new Error('ORDER_NOT_FOUND');
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
    async triggerTestPayout({ sellerId, amount, description, metadata, dealId }) {
        console.log('[trigger payout] sellerId', sellerId);
        console.log('[trigger payout] amount raw', amount);
        if (!process.env.YOOKASSA_SHOP_ID || !process.env.YOOKASSA_SECRET_KEY || !process.env.YOOKASSA_MODE) {
            throw new SellerPayoutError('SELLER_PAYOUT_CONFIG_ERROR', 500, { message: 'Не настроены параметры YooKassa для выплат.' });
        }
        const payoutMethod = await prisma_1.prisma.sellerPayoutMethod.findFirst({
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
        const normalizedAmount = money_1.money.toRublesString(amountKopecks);
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
        const idempotenceKey = node_crypto_1.default.randomUUID();
        const payoutDescription = description?.trim() || DEFAULT_TEST_PAYOUT_DESCRIPTION;
        const requestBody = {
            amount: { value: normalizedAmount, currency: 'RUB' },
            payout_token: payoutMethod.payoutToken,
            description: payoutDescription,
            metadata: { source: 'seller-dashboard', mode: 'test', ...(metadata ?? {}) },
            deal: { id: resolvedDealId }
        };
        console.log('[trigger payout] request body', requestBody);
        let externalPayout;
        try {
            externalPayout = await yookassaService_1.yookassaService.createPayoutInDeal({
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
        }
        catch (error) {
            console.error('[trigger payout] failed', error);
            const providerMessage = axios_1.default.isAxiosError(error)
                ? String(error.response?.data?.description ?? error.message)
                : String(error);
            throw new SellerPayoutError('SELLER_PAYOUT_PROVIDER_ERROR', 502, {
                message: 'Не удалось создать выплату в YooKassa.',
                providerMessage
            });
        }
        const now = new Date();
        const mappedStatus = externalPayout.status === 'succeeded' ? 'SUCCEEDED' : externalPayout.status === 'canceled' ? 'CANCELED' : 'PENDING';
        const created = await prisma_1.prisma.sellerPayout.create({
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
    async getYooKassaWidgetConfig(sellerId) {
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
    async getYookassaWidgetConfig(sellerId) {
        return this.getYooKassaWidgetConfig(sellerId);
    },
    async saveYookassaCardFromWidget(sellerId, payload) {
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
        };
        const savedMethod = await prisma_1.prisma.$transaction(async (tx) => {
            const existing = await tx.sellerPayoutMethod.findFirst({
                where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD' },
                orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
            });
            if (existing) {
                await tx.sellerPayoutMethod.updateMany({
                    where: { sellerId, isDefault: true },
                    data: { isDefault: false }
                });
                const updated = await tx.sellerPayoutMethod.update({
                    where: { id: existing.id },
                    data: { ...methodData, isDefault: true }
                });
                await tx.sellerPayoutMethod.updateMany({
                    where: { sellerId, methodType: 'BANK_CARD', NOT: { id: existing.id } },
                    data: { status: 'REVOKED', isDefault: false }
                });
                return updated;
            }
            else {
                return tx.sellerPayoutMethod.create({
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
    async getEligibleOrdersForPayout(tx, sellerId, options) {
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
        if (!orders.length)
            return [];
        const orderIds = orders.map((item) => item.id);
        const allocationRows = await tx.sellerPayoutAllocation.findMany({
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
        const allocatedByOrder = new Map();
        for (const row of allocationRows) {
            allocatedByOrder.set(row.orderId, (allocatedByOrder.get(row.orderId) ?? 0) + Number(row.amountKopecks ?? 0));
        }
        const missingDealOrderIds = orders.filter((item) => !item.yookassaDealId).map((item) => item.id);
        const dealByOrderId = new Map();
        if (missingDealOrderIds.length > 0) {
            const relatedPayments = await tx.payment.findMany({
                where: { orderId: { in: missingDealOrderIds } },
                select: { id: true, orderId: true, status: true, payloadJson: true, createdAt: true },
                orderBy: [{ createdAt: 'desc' }]
            });
            for (const payment of relatedPayments) {
                if (dealByOrderId.has(payment.orderId))
                    continue;
                const dealId = extractDealIdFromPayloadJson(payment.payloadJson);
                if (!dealId)
                    continue;
                dealByOrderId.set(payment.orderId, dealId);
            }
            const backfilledOrders = Array.from(dealByOrderId.entries());
            if (backfilledOrders.length > 0) {
                await Promise.all(backfilledOrders.map(([orderId, dealId]) => tx.order.updateMany({
                    where: { id: orderId, yookassaDealId: null },
                    data: { yookassaDealId: dealId, yookassaDealStatus: 'open' }
                })));
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
            console.info(`[seller payout][${label}] eligible summary`, {
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
            });
        }
        return rawEligible;
    },
    async calculateAvailableBalanceKopecks(sellerId) {
        const eligible = await this.getEligibleOrdersForPayout(prisma_1.prisma, sellerId);
        return eligible.reduce((acc, item) => acc + item.availableToPayoutKopecks, 0);
    },
    async createSellerPayout(sellerId, payload) {
        const amountRubles = Number(payload.amount);
        if (!Number.isFinite(amountRubles) || amountRubles <= 0) {
            throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400);
        }
        const amountKopecks = money_1.money.toKopecks(amountRubles);
        if (amountKopecks < MIN_PAYOUT_AMOUNT_KOPECKS) {
            throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_INVALID', 400, {
                min: money_1.money.toRublesString(MIN_PAYOUT_AMOUNT_KOPECKS)
            });
        }
        if (amountKopecks > MAX_PAYOUT_AMOUNT_KOPECKS) {
            throw new SellerPayoutError('SELLER_PAYOUT_LIMIT_EXCEEDED', 400, {
                max: money_1.money.toRublesString(MAX_PAYOUT_AMOUNT_KOPECKS)
            });
        }
        const payoutMethod = await prisma_1.prisma.sellerPayoutMethod.findFirst({
            where: { sellerId, provider: PROVIDER, methodType: 'BANK_CARD', status: 'ACTIVE' },
            orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }]
        });
        if (!payoutMethod)
            throw new SellerPayoutError('SELLER_PAYOUT_METHOD_NOT_FOUND', 404);
        if (!payoutMethod.payoutToken)
            throw new SellerPayoutError('SELLER_PAYOUT_TOKEN_MISSING', 400);
        const mode = payload.mode === 'test' ? 'test' : 'live';
        const allowTestBypass = mode === 'test' && process.env.NODE_ENV !== 'production';
        const availableKopecks = await this.calculateAvailableBalanceKopecks(sellerId);
        if (!allowTestBypass && amountKopecks > availableKopecks) {
            throw new SellerPayoutError('SELLER_PAYOUT_AMOUNT_EXCEEDS_AVAILABLE', 400, {
                requested: money_1.money.toRublesString(amountKopecks),
                available: money_1.money.toRublesString(availableKopecks)
            });
        }
        const orderForDeal = payload.orderId
            ? await this.resolveOrderDealIdForPayout({ sellerId, orderId: payload.orderId })
            : await prisma_1.prisma.order.findFirst({
                where: {
                    items: { some: { product: { sellerId } } },
                    yookassaDealId: { not: null },
                    paymentStatus: 'PAID'
                },
                orderBy: { paidAt: 'desc' },
                select: { id: true, publicNumber: true, yookassaDealId: true }
            });
        const fallbackTestDealId = process.env.YOOKASSA_TEST_DEAL_ID?.trim() || null;
        const dealId = ('dealId' in (orderForDeal ?? {}) ? orderForDeal?.dealId : orderForDeal?.yookassaDealId) ?? (mode === 'test' ? fallbackTestDealId : null);
        if (!dealId) {
            throw new SellerPayoutError('SELLER_PAYOUT_DEAL_NOT_FOUND', 400, {
                mode,
                orderId: payload.orderId ?? null,
                hint: mode === 'test' ? 'Set YOOKASSA_TEST_DEAL_ID or create paid order with yookassaDealId' : null
            });
        }
        const resolvedOrderEntityId = orderForDeal?.order?.id ?? orderForDeal?.id ?? null;
        const resolvedOrderPublicNumber = orderForDeal?.order?.publicNumber ?? orderForDeal?.publicNumber ?? null;
        const referenceOrderId = resolvedOrderEntityId ?? payload.orderId ?? `seller-${sellerId}-test`;
        const idempotenceKey = this.buildStableIdempotenceKey([
            'seller',
            sellerId,
            referenceOrderId,
            payoutMethod.id,
            String(amountKopecks),
            String(Date.now())
        ]);
        let externalPayout;
        try {
            externalPayout = await yookassaService_1.yookassaService.createPayoutInDeal({
                orderId: referenceOrderId,
                dealId,
                sellerAmountKopecks: amountKopecks,
                currency: 'RUB',
                payoutToken: payoutMethod.payoutToken,
                idempotenceKey
            });
        }
        catch (error) {
            throw new SellerPayoutError('SELLER_PAYOUT_PROVIDER_ERROR', 502, { cause: String(error) });
        }
        const now = new Date();
        const mappedStatus = externalPayout.status === 'succeeded' ? 'SUCCEEDED' : externalPayout.status === 'canceled' ? 'CANCELED' : 'PENDING';
        const created = await prisma_1.prisma.sellerPayout.create({
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
    async createFinancePayoutByAmount(sellerId, payload) {
        let amountKopecks;
        try {
            amountKopecks = this.normalizePayoutAmountKopecks(payload.amount);
        }
        catch (error) {
            if (this.isSellerPayoutError(error) && error.code === 'SELLER_PAYOUT_AMOUNT_INVALID') {
                throw new SellerPayoutError('INVALID_PAYOUT_AMOUNT', 400);
            }
            throw error;
        }
        if (amountKopecks <= 0) {
            throw new SellerPayoutError('INVALID_PAYOUT_AMOUNT', 400);
        }
        if (amountKopecks < MIN_PAYOUT_AMOUNT_KOPECKS) {
            throw new SellerPayoutError('INVALID_PAYOUT_AMOUNT', 400, { min: money_1.money.toRublesString(MIN_PAYOUT_AMOUNT_KOPECKS) });
        }
        if (amountKopecks > MAX_PAYOUT_AMOUNT_KOPECKS) {
            throw new SellerPayoutError('INVALID_PAYOUT_AMOUNT', 400, { max: money_1.money.toRublesString(MAX_PAYOUT_AMOUNT_KOPECKS) });
        }
        const payoutMethod = await prisma_1.prisma.sellerPayoutMethod.findFirst({
            where: { sellerId, isDefault: true, provider: PROVIDER, status: 'ACTIVE' },
            orderBy: [{ updatedAt: 'desc' }]
        });
        if (!payoutMethod)
            throw new SellerPayoutError('DEFAULT_PAYOUT_METHOD_NOT_FOUND', 404);
        if (!payoutMethod.payoutToken)
            throw new SellerPayoutError('DEFAULT_PAYOUT_METHOD_NOT_FOUND', 404);
        const reserved = await prisma_1.prisma.$transaction(async (tx) => {
            const inProgressPayout = await tx.sellerPayout.findFirst({
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
                    requested: money_1.money.toRublesString(amountKopecks),
                    available: money_1.money.toRublesString(totalAvailable)
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
                const latestPaymentByOrder = new Map();
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
                    requested: money_1.money.toRublesString(amountKopecks),
                    maxSingleDealAmount: money_1.money.toRublesString(primaryDealAvailable),
                    dealId: primaryDealId
                });
            }
            const allocations = [];
            let remaining = amountKopecks;
            for (const order of eligibleOrders) {
                if (order.dealId !== primaryDealId || remaining <= 0)
                    continue;
                const chunk = Math.min(remaining, order.availableToPayoutKopecks);
                if (chunk <= 0)
                    continue;
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
                node_crypto_1.default.randomUUID()
            ]);
            const created = await tx.sellerPayout.create({
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
            await tx.sellerPayoutAllocation.createMany({
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
        let externalPayout;
        try {
            externalPayout = await yookassaService_1.yookassaService.createPayoutInDeal({
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
        }
        catch (error) {
            await prisma_1.prisma.sellerPayout.update({
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
        const updated = await prisma_1.prisma.sellerPayout.update({
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
    async listSellerPayouts(sellerId, options) {
        const payouts = await prisma_1.prisma.sellerPayout.findMany({
            where: { sellerId },
            orderBy: [{ createdAt: 'desc' }]
        });
        if (!options?.sync)
            return payouts;
        return Promise.all(payouts.map((payout) => this.syncPayoutStatus(sellerId, payout.id)));
    },
    async getSellerPayoutById(sellerId, payoutId, options) {
        const payout = await prisma_1.prisma.sellerPayout.findFirst({ where: { id: payoutId, sellerId } });
        if (!payout)
            throw new SellerPayoutError('PAYOUT_NOT_FOUND', 404);
        if (!options?.sync)
            return payout;
        return this.syncPayoutStatus(sellerId, payoutId);
    },
    async createPayoutForOrder(sellerId, orderId) {
        const defaultMethod = await prisma_1.prisma.sellerPayoutMethod.findFirst({
            where: { sellerId, isDefault: true, provider: PROVIDER, status: 'ACTIVE' },
            orderBy: [{ updatedAt: 'desc' }]
        });
        if (!defaultMethod?.payoutToken) {
            throw new SellerPayoutError('DEFAULT_PAYOUT_METHOD_NOT_FOUND', 404, {
                message: 'Не найден способ выплаты по умолчанию.'
            });
        }
        const reservation = await prisma_1.prisma.$transaction(async (tx) => {
            const order = await tx.order.findFirst({
                where: { id: orderId, items: { some: { product: { sellerId } } } },
                select: {
                    id: true,
                    publicNumber: true,
                    paymentId: true,
                    paymentStatus: true,
                    payoutStatus: true,
                    status: true,
                    currency: true,
                    total: true,
                    yookassaDealId: true,
                    sellerNetAmountKopecks: true,
                    createdAt: true,
                    completedAt: true,
                    paidAt: true
                }
            });
            if (!order)
                throw new SellerPayoutError('ORDER_NOT_FOUND', 404);
            const paymentStatus = normalizePayoutStatus(order.paymentStatus);
            if (paymentStatus !== 'PAID')
                throw new SellerPayoutError('ORDER_NOT_PAID', 400);
            if (PAYMENT_STATUS_REFUND_SET.has(paymentStatus))
                throw new SellerPayoutError('ORDER_REFUND_IN_PROGRESS', 400);
            if (ORDER_TERMINAL_BLOCKED_STATUSES.has(normalizePayoutStatus(order.status)))
                throw new SellerPayoutError('ORDER_NOT_ELIGIBLE_FOR_PAYOUT', 400);
            if (!ORDER_COMPLETED_STATUSES.has(normalizePayoutStatus(order.status)) && !['RELEASED', 'AWAITING_PAYOUT', 'PAID_OUT'].includes(normalizePayoutStatus(order.payoutStatus))) {
                throw new SellerPayoutError('ORDER_NOT_ELIGIBLE_FOR_PAYOUT', 400, { message: 'Заказ ещё не завершён для выплаты.' });
            }
            const dealResolved = await this.resolveOrderDealIdForPayout({ sellerId, orderId: order.id, tx });
            const dealId = dealResolved.dealId;
            if (!isOrderSafeDeal(order, dealId))
                throw new SellerPayoutError('SAFE_DEAL_REQUIRED', 400);
            if (!dealId)
                throw new SellerPayoutError('SELLER_PAYOUT_DEAL_NOT_FOUND', 400, { orderId: order.id });
            const activePayout = await tx.sellerPayout.findFirst({
                where: {
                    sellerId,
                    orderId: order.id,
                    status: { in: [...ACTIVE_PAYOUT_STATUSES] }
                },
                orderBy: [{ createdAt: 'desc' }]
            });
            if (activePayout)
                throw new SellerPayoutError('PAYOUT_ALREADY_IN_PROGRESS', 409);
            const payoutsForOrder = await tx.sellerPayout.findMany({
                where: { sellerId, orderId: order.id, status: { in: [...ALLOCATION_CONSUMING_PAYOUT_STATUSES] } },
                select: { status: true, amountKopecks: true }
            });
            const alreadyPaidOutKopecks = payoutsForOrder
                .filter((item) => normalizePayoutStatus(item.status) === 'SUCCEEDED')
                .reduce((acc, item) => acc + Number(item.amountKopecks ?? 0), 0);
            const reservedKopecks = payoutsForOrder
                .filter((item) => ACTIVE_PAYOUT_STATUSES.includes(normalizePayoutStatus(item.status)))
                .reduce((acc, item) => acc + Number(item.amountKopecks ?? 0), 0);
            const grossAmountKopecks = Number(order.total ?? 0);
            const sellerNetAmountKopecks = Number(order.sellerNetAmountKopecks ?? grossAmountKopecks);
            const remainingKopecks = Math.max(0, sellerNetAmountKopecks - alreadyPaidOutKopecks - reservedKopecks);
            if (remainingKopecks <= 0) {
                throw new SellerPayoutError(alreadyPaidOutKopecks > 0 ? 'ORDER_ALREADY_PAID_OUT' : 'PAYOUT_AMOUNT_ZERO', 400);
            }
            const idempotenceKey = this.buildStableIdempotenceKey([
                'seller-finance-order-payout',
                sellerId,
                order.id,
                defaultMethod.id,
                String(remainingKopecks)
            ]);
            const created = await tx.sellerPayout.create({
                data: {
                    sellerId,
                    orderId: order.id,
                    dealId,
                    payoutMethodId: defaultMethod.id,
                    provider: PROVIDER,
                    amountKopecks: remainingKopecks,
                    currency: 'RUB',
                    status: 'PROCESSING',
                    description: buildOrderPayoutDescription(order.publicNumber),
                    metadata: {
                        source: 'finance-order-payout',
                        orderId: order.id,
                        publicNumber: order.publicNumber,
                        sellerId
                    },
                    idempotenceKey,
                    requestedAt: new Date()
                }
            });
            console.info('[PAYOUT][ORDER_RESERVE_CREATED]', {
                sellerId,
                orderId: order.id,
                publicNumber: order.publicNumber,
                payoutMethodId: defaultMethod.id,
                dealId,
                availableAmountKopecks: remainingKopecks,
                backfilledDeal: !order.yookassaDealId
            });
            return { payout: created, order, dealId, remainingKopecks, grossAmountKopecks, sellerNetAmountKopecks, alreadyPaidOutKopecks };
        }, { isolationLevel: 'Serializable' });
        let yookassaPayout;
        try {
            yookassaPayout = await yookassaService_1.yookassaService.createPayoutInDeal({
                orderId: reservation.order.id,
                dealId: reservation.dealId,
                sellerAmountKopecks: reservation.remainingKopecks,
                currency: 'RUB',
                payoutToken: defaultMethod.payoutToken,
                idempotenceKey: reservation.payout.idempotenceKey,
                description: buildOrderPayoutDescription(reservation.order.publicNumber),
                metadata: {
                    orderId: reservation.order.id,
                    publicNumber: reservation.order.publicNumber,
                    sellerId
                }
            });
        }
        catch (error) {
            await prisma_1.prisma.sellerPayout.update({
                where: { id: reservation.payout.id },
                data: {
                    status: 'FAILED',
                    externalStatus: 'failed',
                    canceledAt: new Date(),
                    metadata: {
                        ...(reservation.payout.metadata ?? {}),
                        providerError: String(error)
                    }
                }
            });
            throw new SellerPayoutError('PAYOUT_CREATE_FAILED', 502);
        }
        const mappedStatus = yookassaPayout.status === 'succeeded' ? 'SUCCEEDED' : yookassaPayout.status === 'canceled' ? 'CANCELED' : 'PENDING';
        const now = new Date();
        const updated = await prisma_1.prisma.sellerPayout.update({
            where: { id: reservation.payout.id },
            data: {
                externalPayoutId: yookassaPayout.id,
                status: mappedStatus,
                externalStatus: yookassaPayout.status ?? null,
                succeededAt: mappedStatus === 'SUCCEEDED' ? now : null,
                canceledAt: mappedStatus === 'CANCELED' ? now : null,
                rawResponse: yookassaPayout
            }
        });
        await prisma_1.prisma.order.update({
            where: { id: reservation.order.id },
            data: {
                yookassaPayoutId: yookassaPayout.id,
                payoutStatus: mappedStatus === 'SUCCEEDED' ? 'PAID_OUT' : mappedStatus === 'CANCELED' ? 'PAYOUT_CANCELED' : 'PAYOUT_PENDING'
            }
        });
        console.info('[PAYOUT][ORDER_CREATED]', {
            sellerId,
            orderId: reservation.order.id,
            publicNumber: reservation.order.publicNumber,
            payoutId: updated.id,
            externalPayoutId: updated.externalPayoutId,
            payoutStatus: updated.status,
            dealId: reservation.dealId,
            amountKopecks: updated.amountKopecks
        });
        return {
            id: updated.id,
            externalId: updated.externalPayoutId ?? null,
            status: String(updated.status ?? '').toLowerCase(),
            amount: {
                value: money_1.money.toRublesString(updated.amountKopecks),
                currency: updated.currency
            },
            description: updated.description ?? buildOrderPayoutDescription(reservation.order.publicNumber),
            orderId: reservation.order.id,
            dealId: reservation.dealId,
            createdAt: updated.createdAt
        };
    },
    async syncPayoutStatus(sellerId, payoutId) {
        const payout = await prisma_1.prisma.sellerPayout.findFirst({
            where: { id: payoutId, sellerId }
        });
        if (!payout)
            throw new SellerPayoutError('PAYOUT_NOT_FOUND', 404);
        const external = await yookassaService_1.yookassaService.getPayout(payout.externalPayoutId);
        const mappedStatus = external.status === 'succeeded' ? 'SUCCEEDED' : external.status === 'canceled' ? 'CANCELED' : 'PENDING';
        const cancellationDetails = external.cancellation_details ?? null;
        const updated = await prisma_1.prisma.sellerPayout.update({
            where: { id: payout.id },
            data: {
                status: mappedStatus,
                externalStatus: external.status ?? null,
                succeededAt: mappedStatus === 'SUCCEEDED' ? new Date(String(external.succeeded_at ?? new Date().toISOString())) : null,
                canceledAt: mappedStatus === 'CANCELED' ? new Date() : null,
                cancellationParty: cancellationDetails?.party ?? null,
                cancellationReason: cancellationDetails?.reason ?? null,
                rawResponse: external
            }
        });
        if (payout.orderId) {
            await prisma_1.prisma.order.update({
                where: { id: payout.orderId },
                data: {
                    payoutStatus: mappedStatus === 'SUCCEEDED' ? 'PAID_OUT' : mappedStatus === 'CANCELED' ? 'PAYOUT_CANCELED' : 'PAYOUT_PENDING'
                }
            });
        }
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
                yookassaDealId: true,
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
                completedAt: true,
                deliveredAt: true,
                paidAt: true,
                refunds: { select: { id: true, amount: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
                sellerPayouts: {
                    select: {
                        id: true,
                        externalPayoutId: true,
                        status: true,
                        amountKopecks: true,
                        createdAt: true,
                        updatedAt: true,
                        succeededAt: true,
                        canceledAt: true,
                        description: true,
                        currency: true,
                        payoutMethod: { select: { methodType: true, maskedLabel: true, cardLast4: true } }
                    },
                    orderBy: { createdAt: 'desc' }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
        const summary = { awaitingPayoutKopecks: 0, frozenKopecks: 0, paidOutKopecks: 0, refundedKopecks: 0, blockedKopecks: 0 };
        const payoutQueue = [];
        const payoutCenterAvailableOrders = [];
        const adjustments = [];
        const payoutHistory = [];
        const seenAdjustments = new Set();
        const payoutMethods = await this.listPayoutMethods(sellerId);
        const hasDefaultPayoutMethod = Boolean(payoutMethods.find((item) => item.isDefault && item.status === 'ACTIVE'));
        const orderIds = orders.map((order) => order.id);
        const allocations = orderIds.length
            ? await prisma_1.prisma.sellerPayoutAllocation.findMany({
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
        const payoutConsumptionByOrder = new Map();
        for (const allocation of allocations) {
            const current = payoutConsumptionByOrder.get(allocation.orderId) ?? { reserved: 0, paidOut: 0 };
            const amount = Number(allocation.amountKopecks ?? 0);
            if (String(allocation.payout?.status ?? '').toUpperCase() === 'SUCCEEDED')
                current.paidOut += amount;
            else
                current.reserved += amount;
            payoutConsumptionByOrder.set(allocation.orderId, current);
        }
        for (const order of orders) {
            const gross = order.grossAmountKopecks ?? order.total;
            const platformFee = order.platformFeeKopecks ?? 0;
            const providerFee = order.acquiringFeeKopecks ?? 0;
            const serviceFee = order.serviceFeeKopecks ?? platformFee + providerFee;
            const net = order.sellerNetAmountKopecks ?? Math.max(0, gross - serviceFee);
            const payoutConsumption = payoutConsumptionByOrder.get(order.id) ?? { reserved: 0, paidOut: 0 };
            const availableForPayout = Math.max(0, net - payoutConsumption.paidOut - payoutConsumption.reserved);
            const payoutStatus = normalizePayoutStatus(order.payoutStatus);
            const paymentStatus = normalizePayoutStatus(order.paymentStatus);
            if (PAYMENT_STATUS_REFUND_SET.has(paymentStatus))
                summary.refundedKopecks += net;
            else if (SUCCESS_PAYOUT_STATUSES.has(payoutStatus))
                summary.paidOutKopecks += net;
            else if (BLOCKED_PAYOUT_STATUSES.has(payoutStatus))
                summary.blockedKopecks += net;
            else if (AWAITING_PAYOUT_STATUSES.has(payoutStatus)) {
                summary.awaitingPayoutKopecks += availableForPayout;
                summary.frozenKopecks += payoutConsumption.reserved;
                summary.paidOutKopecks += payoutConsumption.paidOut;
            }
            else if (FROZEN_PAYOUT_STATUSES.has(payoutStatus) || PAYOUT_PENDING_STATUSES.has(payoutStatus)) {
                summary.frozenKopecks += availableForPayout + payoutConsumption.reserved;
                summary.paidOutKopecks += payoutConsumption.paidOut;
            }
            else {
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
                    grossAmountRubles: money_1.money.toRublesString(gross),
                    serviceFeeKopecks: serviceFee,
                    serviceFeeRubles: money_1.money.toRublesString(serviceFee),
                    platformFeeKopecks: platformFee,
                    platformFeeRubles: money_1.money.toRublesString(platformFee),
                    providerFeeKopecks: providerFee,
                    providerFeeRubles: money_1.money.toRublesString(providerFee),
                    sellerNetAmountKopecks: availableForPayout,
                    sellerNetAmountRubles: money_1.money.toRublesString(availableForPayout),
                    payoutStatus: payoutStatus || null,
                    orderStatus: order.status,
                    paymentStatus: order.paymentStatus
                });
            }
            const hasActivePayout = (order.sellerPayouts ?? []).some((item) => ACTIVE_PAYOUT_STATUSES.includes(normalizePayoutStatus(item.status)));
            const hasDealId = Boolean(order.yookassaDealId);
            const completedAt = order.completedAt ?? order.paidAt ?? null;
            let canPayout = true;
            let reason = null;
            if (paymentStatus !== 'PAID') {
                canPayout = false;
                reason = 'ORDER_NOT_PAID';
            }
            else if (PAYMENT_STATUS_REFUND_SET.has(paymentStatus)) {
                canPayout = false;
                reason = 'ORDER_REFUND_IN_PROGRESS';
            }
            else if (ORDER_TERMINAL_BLOCKED_STATUSES.has(normalizePayoutStatus(order.status))) {
                canPayout = false;
                reason = 'ORDER_NOT_ELIGIBLE_FOR_PAYOUT';
            }
            else if (availableForPayout <= 0) {
                canPayout = false;
                reason = 'ORDER_ALREADY_PAID_OUT';
            }
            else if (hasActivePayout) {
                canPayout = false;
                reason = 'PAYOUT_ALREADY_IN_PROGRESS';
            }
            else if (!hasDealId) {
                canPayout = false;
                reason = 'SELLER_PAYOUT_DEAL_NOT_FOUND';
            }
            else if (!hasDefaultPayoutMethod) {
                canPayout = false;
                reason = 'DEFAULT_PAYOUT_METHOD_NOT_FOUND';
            }
            if (availableForPayout > 0 || hasActivePayout) {
                payoutCenterAvailableOrders.push({
                    orderId: order.id,
                    publicNumber: order.publicNumber,
                    label: `#${order.publicNumber}`,
                    createdAt: order.createdAt.toISOString(),
                    completedAt: completedAt?.toISOString?.() ?? null,
                    availableAmountMinor: availableForPayout,
                    availableAmountFormatted: money_1.money.toRublesString(availableForPayout),
                    currency: order.currency ?? 'RUB',
                    canPayout,
                    statusLabel: payoutStatus || 'UNKNOWN',
                    descriptionPreview: buildOrderPayoutDescription(order.publicNumber),
                    payoutMethodRequired: !hasDefaultPayoutMethod,
                    hasDealId,
                    reason
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
                payoutHistory.push({
                    id: payout.id,
                    externalId: payout.externalPayoutId ?? null,
                    orderId: order.id,
                    publicNumber: order.publicNumber,
                    createdAt: payout.createdAt.toISOString(),
                    updatedAt: payout.updatedAt?.toISOString?.() ?? payout.createdAt.toISOString(),
                    succeededAt: payout.succeededAt?.toISOString() ?? payout.createdAt.toISOString(),
                    canceledAt: payout.canceledAt?.toISOString?.() ?? null,
                    status: String(payout.status ?? '').toLowerCase(),
                    amountKopecks: payout.amountKopecks,
                    amountMinor: payout.amountKopecks,
                    amountRubles: money_1.money.toRublesString(payout.amountKopecks),
                    currency: payout.currency ?? order.currency ?? 'RUB',
                    description: payout.description ?? buildOrderPayoutDescription(order.publicNumber),
                    grossAmountKopecks: gross,
                    grossAmountRubles: money_1.money.toRublesString(gross),
                    serviceFeeKopecks: serviceFee,
                    serviceFeeRubles: money_1.money.toRublesString(serviceFee),
                    platformFeeKopecks: platformFee,
                    platformFeeRubles: money_1.money.toRublesString(platformFee),
                    providerFeeKopecks: providerFee,
                    providerFeeRubles: money_1.money.toRublesString(providerFee),
                    sellerNetAmountKopecks: net,
                    sellerNetAmountRubles: money_1.money.toRublesString(net),
                    payoutMethodSummary: payout.payoutMethod?.maskedLabel ?? payout.payoutMethod?.methodType ?? null
                });
            }
        }
        const nextPayoutAmountKopecks = payoutQueue.reduce((acc, item) => acc + item.sellerNetAmountKopecks, 0);
        const availableToPayoutKopecks = payoutCenterAvailableOrders
            .filter((item) => item.canPayout)
            .reduce((acc, item) => acc + Number(item.availableAmountMinor ?? 0), 0);
        return {
            summary: {
                ...summary,
                awaitingPayoutKopecks: availableToPayoutKopecks,
                awaitingPayoutRubles: money_1.money.toRublesString(availableToPayoutKopecks),
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
            payoutCenter: {
                availableOrders: payoutCenterAvailableOrders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
            },
            payoutQueue,
            adjustments,
            payoutHistory: payoutHistory.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
            payoutMethodsSummary: {
                total: payoutMethods.length,
                active: payoutMethods.filter((item) => item.status === 'ACTIVE').length,
                defaultMethodId: payoutMethods.find((item) => item.isDefault)?.id ?? null
            }
        };
    },
    buildStableIdempotenceKey(parts) {
        return node_crypto_1.default.createHash('sha256').update(parts.join(':')).digest('hex');
    },
    isSellerPayoutError(error) {
        return error instanceof SellerPayoutError;
    }
};
