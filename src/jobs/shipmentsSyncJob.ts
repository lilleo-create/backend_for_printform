import { prisma } from '../lib/prisma';
import { cdekService } from '../services/cdekService';
import { payoutService } from '../services/payoutService';

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

// Маппинг статусов CDEK -> внутренний статус заказа
// https://api.cdek.ru/v2/statuses
export const mapCdekStatus = (code: string): 'READY_FOR_SHIPMENT' | 'HANDED_TO_DELIVERY' | 'IN_TRANSIT' | 'DELIVERED' | 'CANCELLED' | 'RETURNED' | null => {
  if (!code) return null;
  if (code === 'DELIVERED') return 'DELIVERED';
  if (code === 'NOT_DELIVERED') return 'RETURNED';
  if (code === 'INVALID' || code === 'REMOVED' || code === 'CANCELLED') return 'CANCELLED';
  if (code === 'CREATED') return 'READY_FOR_SHIPMENT';
  if (code === 'ACCEPTED') return 'HANDED_TO_DELIVERY';
  if (
    code === 'RETURNED' ||
    code === 'RETURN_ORDERS_TRANSIT' ||
    code === 'RETURN_ORDERS_RECEIVED'
  ) return 'RETURNED';
  if (
    code === 'RECEIVED_AT_SHIPMENT_WAREHOUSE' ||
    code === 'READY_FOR_SHIPMENT_IN_SENDER_CITY' ||
    code === 'TAKEN_BY_TRANSPORTER_FROM_SENDER' ||
    code === 'SENT_TO_TRANSIT_CITY' ||
    code === 'ACCEPTED_IN_TRANSIT_CITY' ||
    code === 'ACCEPTED_AT_RECIPIENT_CITY_WAREHOUSE' ||
    code === 'ACCEPTED_AT_PICK_UP_POINT' ||
    code === 'READY_FOR_DELIVERY' ||
    code === 'DELIVERING'
  ) return 'IN_TRANSIT';
  return null;
};

export const runShipmentsSyncJob = async () => {
  // Синхронизируем только заказы с CDEK order id, которые ещё не завершены
  const orders = await prisma.order.findMany({
    where: {
      cdekOrderId: { not: null },
      status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED'] }
    },
    select: { id: true, cdekOrderId: true, cdekStatus: true }
  });

  let synced = 0;
  for (const order of orders) {
    if (!order.cdekOrderId) continue;
    try {
      const info = await cdekService.getOrderInfo(order.cdekOrderId);
      const newCdekStatus = info.status;

      if (!newCdekStatus || newCdekStatus === order.cdekStatus) continue;

      const internalStatus = mapCdekStatus(newCdekStatus);

      await prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: order.id },
          data: {
            cdekStatus: newCdekStatus,
            trackingNumber: info.trackingNumber || undefined,
            ...(internalStatus ? { status: internalStatus } : {}),
            ...(internalStatus === 'CANCELLED' || internalStatus === 'RETURNED'
              ? { payoutStatus: 'BLOCKED' }
              : {})
          }
        });

        await tx.orderDeliveryEvent.create({
          data: {
            orderId: order.id,
            provider: 'CDEK',
            status: newCdekStatus,
            raw: info as unknown as object
          }
        });

        if (internalStatus === 'DELIVERED') {
          await payoutService.releaseForDeliveredOrder(order.id, tx as any);
        }
      });

      synced++;
    } catch (error) {
      console.error('[SHIPMENTS_SYNC_JOB][CDEK] order sync failed', { orderId: order.id, error });
    }
  }

  console.info('[SHIPMENTS_SYNC_JOB][CDEK]', { total: orders.length, synced });
  return { total: orders.length, synced };
};

export const runShipmentSlaJob = async () => {
  const result = await prisma.order.updateMany({
    where: {
      status: 'READY_FOR_SHIPMENT',
      dropoffDeadlineAt: { lt: new Date() },
      cdekOrderId: null
    },
    data: { status: 'EXPIRED' }
  });
  if (result.count > 0) {
    console.info('[SHIPMENT_SLA_JOB]', { expired: result.count });
  }
};

export const startShipmentsSyncJob = () => {
  if (timer) return;

  timer = setInterval(() => {
    runShipmentsSyncJob().catch((error) => {
      console.error('[SHIPMENTS_SYNC_JOB] failed', error);
    });
    runShipmentSlaJob().catch((error) => {
      console.error('[SHIPMENT_SLA_JOB] failed', error);
    });
  }, SYNC_INTERVAL_MS);
};
