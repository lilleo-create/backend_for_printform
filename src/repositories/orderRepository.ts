import { OrderStatus } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { nextPaymentExpiryDate } from '../utils/orderPayment';
import { calculateOrderEconomics } from '../utils/orderEconomics';
import { formatOrderPublicNumber } from '../utils/orderPublicId';
import { BUYER_PUBLIC_SELECT } from '../utils/serializers';
import type { ShippingSnapshot } from '../services/shippingPackageService';

export const orderRepository = {
  create: (data: {
    buyerId: string;
    paymentAttemptKey?: string;
    contactId?: string;
    shippingAddressId?: string;
    buyerPickupPvz?: { provider?: 'CDEK'; pvzId: string; raw: unknown; addressFull?: string };
    sellerDropoffPvz?: { provider?: 'CDEK'; pvzId: string; raw: unknown; addressFull?: string };
    recipient?: { name: string; phone: string; email?: string | null };
    packagesCount?: number;
    shippingSnapshot?: ShippingSnapshot;
    orderLabels?: { packageNo: number; code: string }[];
    deliveryAmountKopecks?: number;
    deliveryChargedToBuyerKopecks?: number;
    deliveryDaysMin?: number;
    deliveryDaysMax?: number;
    items: { productId: string; variantId?: string; quantity: number; expectedPriceKopecks?: number }[];
  }) =>
    prisma.$transaction(async (tx) => {
      const uniqueItems = new Set<string>();
      for (const item of data.items) {
        if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 999) throw new Error('QUANTITY_INVALID');
        const key = `${item.productId}\0${item.variantId ?? ''}`;
        if (uniqueItems.has(key)) throw new Error('DUPLICATE_ORDER_ITEM');
        uniqueItems.add(key);
      }
      const productIds = data.items.map((item) => item.productId);
      const variantIds = data.items.map((item) => item.variantId).filter(Boolean) as string[];

      const products = await tx.product.findMany({
        where: { id: { in: productIds }, deletedAt: null, moderationStatus: 'APPROVED' }
      });
      const variants = variantIds.length
        ? await tx.productVariant.findMany({ where: { id: { in: variantIds } } })
        : [];

      if (products.length !== new Set(productIds).size) throw new Error('PRODUCT_NOT_FOUND');
      if (new Set(products.map(product => product.sellerId)).size !== 1) throw new Error('MULTI_SELLER_CHECKOUT_NOT_SUPPORTED');
      const sellerId = products[0].sellerId;
      const seller = await tx.sellerProfile.findFirst({ where: { userId: sellerId, status: 'APPROVED' }, select: { id: true } });
      if (!seller) throw new Error('SELLER_NOT_AVAILABLE');

      const contact = data.contactId ? await tx.contact.findFirst({ where: { id: data.contactId, userId: data.buyerId }, select: { id: true } }) : null;
      if (data.contactId && !contact) throw new Error('CONTACT_NOT_FOUND');
      // The older PVZ checkout sends this sentinel rather than a saved address.
      const shippingAddressId = data.shippingAddressId === 'cdek_pvz' ? undefined : data.shippingAddressId;
      const address = shippingAddressId ? await tx.address.findFirst({ where: { id: shippingAddressId, userId: data.buyerId }, select: { id: true } }) : null;
      if (shippingAddressId && !address) throw new Error('SHIPPING_ADDRESS_NOT_FOUND');

      const itemsWithPrice = data.items.map((item) => {
        const product = products.find((entry) => entry.id === item.productId);
        if (!product) {
          throw new Error('NOT_FOUND');
        }
        const variant = item.variantId
          ? variants.find((entry) => entry.id === item.variantId)
          : undefined;
        if (item.variantId && (!variant || variant.productId !== item.productId)) throw new Error('VARIANT_INVALID');
        const priceAtPurchase = product.price + (variant?.priceDelta ?? 0);
        if (!Number.isSafeInteger(priceAtPurchase) || priceAtPurchase <= 0) throw new Error('PRODUCT_PRICE_INVALID');
        if (item.expectedPriceKopecks != null && item.expectedPriceKopecks !== priceAtPurchase) {
          throw new Error('PRODUCT_PRICE_CHANGED');
        }
        return {
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
          priceAtPurchase,
          currency: product.currency
        };
      });

      const itemsSubtotal = itemsWithPrice.reduce((sum, item) => sum + item.priceAtPurchase * item.quantity, 0);
      const deliveryAmountKopecks = data.deliveryAmountKopecks ?? 0;
      const deliveryChargedToBuyerKopecks = data.deliveryChargedToBuyerKopecks ?? 0;
      const total = itemsSubtotal + deliveryChargedToBuyerKopecks;
      const economics = calculateOrderEconomics(total);

      const normalizePvzMeta = (pvz?: { pvzId: string; raw: unknown; addressFull?: string; provider?: 'CDEK' }) => {
        if (!pvz) return undefined;
        const raw = pvz.raw && typeof pvz.raw === 'object' && !Array.isArray(pvz.raw)
          ? (pvz.raw as Record<string, unknown>)
          : {};

        return {
          provider: 'CDEK' as const,
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
          publicNumber: formatOrderPublicNumber(sequence.lastValue),
          buyerId: data.buyerId,
          paymentAttemptKey: data.paymentAttemptKey,
          contactId: data.contactId,
          shippingAddressId,
          buyerPickupPvzId: normalizedBuyerPickupPvz?.pvzId,
          buyerPickupPvzMeta: (normalizedBuyerPickupPvz as unknown as object | undefined) ?? undefined,
          sellerDropoffPvzId: normalizedSellerDropoffPvz?.pvzId,
          sellerDropoffPvzMeta: (normalizedSellerDropoffPvz as unknown as object | undefined) ?? undefined,
          carrier: 'CDEK',
          recipientName: data.recipient?.name,
          recipientPhone: data.recipient?.phone,
          recipientEmail: data.recipient?.email ?? null,
          packagesCount: data.packagesCount ?? 1,
          shippingSnapshot: data.shippingSnapshot as any,
          orderLabels: (data.orderLabels as unknown as object | undefined) ?? undefined,
          total,
          // Only include when non-zero so old Prisma clients use DB default(0) safely
          ...(deliveryAmountKopecks > 0 ? { deliveryAmountKopecks } : {}),
          checkoutDeliveryEstimateKopecks: deliveryAmountKopecks,
          deliveryChargedToBuyerKopecks,
          ...(data.shippingSnapshot ? { deliveryCalculatedAt: new Date() } : {}),
          ...(data.deliveryDaysMin != null && data.deliveryDaysMin > 0 ? { deliveryDaysMin: data.deliveryDaysMin } : {}),
          ...(data.deliveryDaysMax != null && data.deliveryDaysMax > 0 ? { deliveryDaysMax: data.deliveryDaysMax } : {}),
          ...(data.deliveryDaysMin != null && data.deliveryDaysMax != null && data.deliveryDaysMin > 0
            ? { deliveryEtaText: `${data.deliveryDaysMin}–${data.deliveryDaysMax} дней` }
            : {}),
          grossAmountKopecks: economics.grossAmountKopecks,
          serviceFeeKopecks: economics.serviceFeeKopecks,
          platformFeeKopecks: economics.platformFeeKopecks,
          acquiringFeeKopecks: economics.acquiringFeeKopecks,
          sellerNetAmountKopecks: economics.sellerNetAmountKopecks,
          ...(economics.platformFeePercent > 0 ? { platformFeePercent: economics.platformFeePercent } : {}),
          paymentStatus: 'PENDING_PAYMENT',
          paymentExpiresAt: nextPaymentExpiryDate(),
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
  findByBuyer: (buyerId: string) =>
    prisma.order.findMany({
      where: { buyerId },
      include: { items: { include: { product: true } }, contact: true, shippingAddress: true },
      orderBy: { createdAt: 'desc' }
    }),
  findById: (id: string) =>
    prisma.order.findUnique({
      where: { id },
      include: { items: { include: { product: true } }, contact: true, shippingAddress: true }
    }),
  findSellerOrders: (
    sellerId: string,
    options?: {
      status?: OrderStatus;
      offset?: number;
      limit?: number;
      search?: string;
    }
  ) =>
    {
      const search = options?.search?.trim();
      const digitsOnly = search?.replace(/\D/g, '') ?? '';
      const searchFilter = search
        ? {
            OR: [
              { publicNumber: { contains: search, mode: 'insensitive' as const } },
              ...(digitsOnly ? [{ publicNumber: { endsWith: digitsOnly } }] : [])
            ]
          }
        : {};

      return prisma.order.findMany({
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
          buyer: { select: BUYER_PUBLIC_SELECT }
        },
        orderBy: { createdAt: 'desc' },
        skip: options?.offset ?? 0,
        take: options?.limit ?? 50
      });
    }
};
