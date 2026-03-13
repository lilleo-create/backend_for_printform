"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderRepository = void 0;
const prisma_1 = require("../lib/prisma");
exports.orderRepository = {
    create: (data) => prisma_1.prisma.$transaction(async (tx) => {
        const productIds = data.items.map((item) => item.productId);
        const variantIds = data.items.map((item) => item.variantId).filter(Boolean);
        const products = await tx.product.findMany({
            where: { id: { in: productIds } }
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
        return tx.order.create({
            data: {
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
    findSellerOrders: (sellerId, options) => prisma_1.prisma.order.findMany({
        where: {
            items: { some: { product: { sellerId } } },
            ...(options?.status ? { status: options.status } : {})
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
    })
};
