"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderRepository = void 0;
const prisma_1 = require("../lib/prisma");
const orderPayment_1 = require("../utils/orderPayment");
const orderEconomics_1 = require("../utils/orderEconomics");
const orderPublicId_1 = require("../utils/orderPublicId");
exports.orderRepository = {
    create: (data) => prisma_1.prisma.$transaction(async (tx) => {
        const productIds = data.items.map((item) => item.productId);
        const variantIds = data.items.map((item) => item.variantId).filter(Boolean);
        const products = await tx.product.findMany({
            where: { id: { in: productIds }, deletedAt: null, moderationStatus: 'APPROVED' }
        });
        const variants = variantIds.length
            ? await tx.productVariant.findMany({ where: { id: { in: variantIds } } })
            : [];
        const itemsWithPrice = data.items.map((item) => {
            const product = products.find((entry) => entry.id === item.productId);
            if (!product) {
                throw new Error('NOT_FOUND');
            }
            const variant = item.variantId
                ? variants.find((entry) => entry.id === item.variantId)
                : undefined;
            const priceAtPurchase = product.price + (variant?.priceDelta ?? 0);
            return {
                productId: item.productId,
                variantId: item.variantId,
                quantity: item.quantity,
                priceAtPurchase,
                currency: product.currency
            };
        });
        const total = itemsWithPrice.reduce((sum, item) => sum + item.priceAtPurchase * item.quantity, 0);
        const economics = (0, orderEconomics_1.calculateOrderEconomics)(total);
        const normalizePvzMeta = (pvz) => {
            if (!pvz)
                return undefined;
            const raw = pvz.raw && typeof pvz.raw === 'object' && !Array.isArray(pvz.raw)
                ? pvz.raw
                : {};
            return {
                provider: 'CDEK',
                pvzId: pvz.pvzId,
                addressFull: pvz.addressFull,
                raw: {
                    ...raw,
                    id: pvz.pvzId,
                    type: 'PVZ'
                }
            };
        };
        const normalizedBuyerPickupPvz = normalizePvzMeta(data.buyerPickupPvz);
        const normalizedSellerDropoffPvz = normalizePvzMeta(data.sellerDropoffPvz);
        const sequence = await tx.orderPublicNumberCounter.upsert({
            where: { scope: 'ORDER' },
            create: { scope: 'ORDER', lastValue: 1 },
            update: { lastValue: { increment: 1 } },
            select: { lastValue: true }
        });
        return tx.order.create({
            data: {
                publicNumber: (0, orderPublicId_1.formatOrderPublicNumber)(sequence.lastValue),
                buyerId: data.buyerId,
                paymentAttemptKey: data.paymentAttemptKey,
                contactId: data.contactId,
                shippingAddressId: data.shippingAddressId,
                buyerPickupPvzId: normalizedBuyerPickupPvz?.pvzId,
                buyerPickupPvzMeta: normalizedBuyerPickupPvz ?? undefined,
                sellerDropoffPvzId: normalizedSellerDropoffPvz?.pvzId,
                sellerDropoffPvzMeta: normalizedSellerDropoffPvz ?? undefined,
                carrier: 'CDEK',
                recipientName: data.recipient?.name,
                recipientPhone: data.recipient?.phone,
                recipientEmail: data.recipient?.email ?? null,
                packagesCount: data.packagesCount ?? 1,
                orderLabels: data.orderLabels ?? undefined,
                total,
                grossAmountKopecks: economics.grossAmountKopecks,
                serviceFeeKopecks: economics.serviceFeeKopecks,
                platformFeeKopecks: economics.platformFeeKopecks,
                acquiringFeeKopecks: economics.acquiringFeeKopecks,
                sellerNetAmountKopecks: economics.sellerNetAmountKopecks,
                paymentStatus: 'PENDING_PAYMENT',
                paymentExpiresAt: (0, orderPayment_1.nextPaymentExpiryDate)(),
                expiredAt: null,
                items: {
                    create: itemsWithPrice
                }
            },
            include: {
                items: { include: { product: true, variant: true } },
                contact: true,
                shippingAddress: true
            }
        });
    }),
    findByBuyer: (buyerId) => prisma_1.prisma.order.findMany({
        where: { buyerId },
        include: { items: { include: { product: true } }, contact: true, shippingAddress: true },
        orderBy: { createdAt: 'desc' }
    }),
    findById: (id) => prisma_1.prisma.order.findUnique({
        where: { id },
        include: { items: { include: { product: true } }, contact: true, shippingAddress: true }
    }),
    findSellerOrders: (sellerId, options) => {
        const search = options?.search?.trim();
        const digitsOnly = search?.replace(/\D/g, '') ?? '';
        const searchFilter = search
            ? {
                OR: [
                    { publicNumber: { contains: search, mode: 'insensitive' } },
                    ...(digitsOnly ? [{ publicNumber: { endsWith: digitsOnly } }] : [])
                ]
            }
            : {};
        return prisma_1.prisma.order.findMany({
            where: {
                items: { some: { product: { sellerId } } },
                NOT: [{ paymentStatus: 'PAYMENT_EXPIRED' }],
                ...(options?.status ? { status: options.status } : {}),
                ...searchFilter
            },
            include: {
                items: {
                    where: { product: { sellerId } },
                    include: { product: true, variant: true }
                },
                contact: true,
                shippingAddress: true,
                buyer: true
            },
            orderBy: { createdAt: 'desc' },
            skip: options?.offset ?? 0,
            take: options?.limit ?? 50
        });
    }
};
