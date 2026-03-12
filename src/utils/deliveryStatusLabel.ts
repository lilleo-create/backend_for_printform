import type { Order } from '@prisma/client';

type OrderLike = Pick<Order, 'status' | 'paidAt' | 'trackingNumber' | 'cdekOrderId'> & {
  shipmentStatus?: string | null;
};

const normalize = (value?: string | null) => String(value ?? '').toUpperCase();

export const resolveDeliveryStatusLabel = (order: OrderLike) => {
  if (!order.paidAt) return 'Ожидает оплаты';

  const shipmentStatus = normalize(order.shipmentStatus);

  if (!shipmentStatus && !order.trackingNumber && !order.cdekOrderId) return 'Оформляется';
  if (shipmentStatus === 'PRINTING' || shipmentStatus === 'DOCS_PRINTING') return 'Печатается';

  if (
    shipmentStatus === 'READY_TO_SHIP' ||
    shipmentStatus === 'READY_FOR_DROP' ||
    shipmentStatus === 'ACCEPTED_AT_SOURCE_WAREHOUSE' ||
    shipmentStatus === 'ACCEPTED_AT_PICK_UP_POINT' ||
    shipmentStatus === 'HANDED_TO_CDEK'
  ) {
    return 'Передается в ПВЗ';
  }

  if (
    shipmentStatus === 'IN_TRANSIT' ||
    shipmentStatus === 'ACCEPTED_IN_TRANSIT_CITY' ||
    shipmentStatus === 'DELIVERY_TRANSPORTATION' ||
    shipmentStatus === 'TRANSPORTING'
  ) {
    return 'В пути';
  }

  if (
    shipmentStatus === 'READY_FOR_PICKUP' ||
    shipmentStatus === 'READY_FOR_PICKUP_POINT' ||
    shipmentStatus === 'DELIVERY_AT_PICKUP_POINT' ||
    shipmentStatus === 'DELIVERED_TO_PVZ'
  ) {
    return 'Готов к выдаче';
  }

  if (shipmentStatus === 'DELIVERED' || shipmentStatus === 'ISSUED') return 'Выдан';

  return 'Оформляется';
};
