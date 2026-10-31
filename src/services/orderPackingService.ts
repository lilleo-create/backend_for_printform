import { prisma } from '../lib/prisma';
import { cityCodeFromPvz } from './checkoutShippingService';
import { cdekService } from './cdekService';
import {
  calculatePackedShippingQuote, type PackedParcel, type ShippingSnapshot,
  ShippingQuoteError
} from './shippingPackageService';

const fail = (code: string): never => { throw new ShippingQuoteError(code); };

const assertCanPack = (order: any, sellerId: string, hasShipment: boolean) => {
  if (!order || !Array.isArray(order.items)) return fail('ORDER_NOT_FOUND');
  const sellerIds = new Set(order.items.map((item: any) => item.product?.sellerId));
  if (sellerIds.size !== 1 || !sellerIds.has(sellerId)) return fail('ORDER_NOT_FOUND');
  if (order.paymentStatus !== 'PAID' || !order.paidAt) return fail('PAYMENT_REQUIRED');
  if (order.status === 'PAID') return fail('PRODUCTION_NOT_STARTED');
  if (order.status !== 'PRINTING' || hasShipment || order.cdekOrderId || order.readyForShipmentAt) {
    return fail('FULFILLMENT_LOCKED');
  }
  if (!order.shippingSnapshot) return fail('SHIPPING_SNAPSHOT_MISSING');
  if (!order.sellerDropoffPvzId) return fail('SELLER_DROPOFF_PVZ_REQUIRED');
  if (!order.buyerPickupPvzId) return fail('BUYER_PICKUP_PVZ_REQUIRED');
};

const load = async (orderId: string, sellerId: string) => {
  const order = await prisma.order.findFirst({
    where: { id: orderId, items: { some: { product: { sellerId } } } },
    include: { items: { include: { product: { select: { sellerId: true } } } } }
  });
  const shipment = await prisma.orderShipment.findUnique({ where: { orderId } });
  assertCanPack(order, sellerId, Boolean(shipment));
  return order!;
};

const cityCode = async (meta: unknown, pvzId: string, errorCode: string) => {
  const code = cityCodeFromPvz(meta) || await cdekService.getCityCodeByPvzCode(pvzId);
  if (!code) return fail(errorCode);
  return code;
};

export const orderPackingService = {
  async quote(orderId: string, sellerId: string, parcel: PackedParcel, requestId?: string) {
    const order = await load(orderId, sellerId);
    const fromCityCode = await cityCode(order.sellerDropoffPvzMeta, order.sellerDropoffPvzId!, 'SELLER_CITY_CODE_REQUIRED');
    const toCityCode = await cityCode(order.buyerPickupPvzMeta, order.buyerPickupPvzId!, 'BUYER_CITY_CODE_REQUIRED');
    const result = await calculatePackedShippingQuote(parcel, order.shippingSnapshot as ShippingSnapshot,
      fromCityCode, toCityCode, params => cdekService.calculateDelivery(params,
        requestId ? { requestId, orderId } : undefined), {
        shipmentPoint: order.sellerDropoffPvzId!, deliveryPoint: order.buyerPickupPvzId!
      });
    return {
      deliveryAmountKopecks: result.deliveryAmountKopecks,
      deliveryDaysMin: result.quote.deliveryDaysMin,
      deliveryDaysMax: result.quote.deliveryDaysMax
    };
  },

  async confirm(orderId: string, sellerId: string, parcel: PackedParcel, expectedDeliveryAmountKopecks: number) {
    const quote = await this.quote(orderId, sellerId, parcel);
    if (quote.deliveryAmountKopecks !== expectedDeliveryAmountKopecks) {
      return fail('PACKED_QUOTE_CHANGED');
    }
    return prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const current = await tx.order.findUnique({
        where: { id: orderId },
        include: { items: { include: { product: { select: { sellerId: true } } } } }
      });
      const shipment = await tx.orderShipment.findUnique({ where: { orderId } });
      assertCanPack(current, sellerId, Boolean(shipment));
      if (current!.isPacked && current!.packedWeightGrams === parcel.weightGrams &&
          current!.packedLengthCm === parcel.lengthCm && current!.packedWidthCm === parcel.widthCm &&
          current!.packedHeightCm === parcel.heightCm &&
          current!.packedDeliveryAmountKopecks === quote.deliveryAmountKopecks) {
        return current!;
      }
      const now = new Date();
      return tx.order.update({
        where: { id: orderId },
        data: {
          packedWeightGrams: parcel.weightGrams,
          packedLengthCm: parcel.lengthCm,
          packedWidthCm: parcel.widthCm,
          packedHeightCm: parcel.heightCm,
          packedDeliveryAmountKopecks: quote.deliveryAmountKopecks,
          deliveryAmountKopecks: quote.deliveryAmountKopecks,
          packedAt: now,
          packedQuoteCalculatedAt: now,
          fulfillmentUpdatedAt: now,
          isPacked: true
        }
      });
    });
  }
};
