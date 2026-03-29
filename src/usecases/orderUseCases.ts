import { OrderStatus, Prisma } from '@prisma/client';
import { orderRepository } from '../repositories/orderRepository';
import { userRepository } from '../repositories/userRepository';
import { sheetsService } from '../services/sheetsService';

export const orderUseCases = {
  create: async (data: {
    buyerId: string;
    paymentAttemptKey?: string;
    contactId?: string;
    shippingAddressId?: string;
    buyerPickupPvz?: { provider?: 'CDEK'; pvzId: string; raw: unknown; addressFull?: string };
    sellerDropoffPvz?: { provider?: 'CDEK'; pvzId: string; raw: unknown; addressFull?: string };
    recipient?: { name: string; phone: string; email?: string | null };
    packagesCount?: number;
    orderLabels?: { packageNo: number; code: string }[];
    items: { productId: string; variantId?: string; quantity: number }[];
  }) => {
    let order: any;
    try {
      order = await orderRepository.create(data);
    } catch (error) {
      console.error('[PAYMENT][ORDER_CREATE_ERROR]', {
        buyerId: data.buyerId,
        paymentAttemptKey: data.paymentAttemptKey ?? null,
        error,
        stack: error instanceof Error ? error.stack : undefined,
        prismaCode: error instanceof Prisma.PrismaClientKnownRequestError ? error.code : undefined,
        prismaMeta: error instanceof Prisma.PrismaClientKnownRequestError ? error.meta : undefined,
        prismaValidation: error instanceof Prisma.PrismaClientValidationError ? error.message : undefined
      });

      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === 'P2002') {
          console.error('[PAYMENT][ORDER_CREATE_ERROR][P2002]', { meta: error.meta });
        }
        if (error.code === 'P2003') {
          console.error('[PAYMENT][ORDER_CREATE_ERROR][RELATION_CONSTRAINT]', { meta: error.meta });
        }
        if (error.code === 'P2011') {
          console.error('[PAYMENT][ORDER_CREATE_ERROR][NULL_CONSTRAINT]', { meta: error.meta });
        }
        if (error.code === 'P2009') {
          console.error('[PAYMENT][ORDER_CREATE_ERROR][INVALID_ENUM_OR_INPUT]', { meta: error.meta });
        }
      }

      throw error;
    }
    const buyer = await userRepository.findById(data.buyerId);

    if (buyer) {
      await Promise.all(
        order.items.map(async (item: any) => {
          try {
            await sheetsService.appendOrderRow({
              orderId: order.id,
              createdAt: order.createdAt.toISOString(),
              userEmail: buyer.email,
              productTitle: item.product.title,
              sku: item.product.sku,
              variant: item.variant?.name ?? '-',
              qty: item.quantity,
              price: item.priceAtPurchase,
              currency: item.currency,
              status: order.status
            });
          } catch (error) {
            console.warn('Sheets append failed', error);
          }
        })
      );
    }

    return order;
  },
  listByBuyer: orderRepository.findByBuyer,
  get: orderRepository.findById,
  listBySeller: (sellerId: string, options?: { status?: OrderStatus; offset?: number; limit?: number }) =>
    orderRepository.findSellerOrders(sellerId, options)
};
