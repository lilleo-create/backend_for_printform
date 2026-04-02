import { prisma } from '../lib/prisma';
import { cdekService } from '../services/cdekService';
import { cdekWebhookService } from '../services/cdekWebhookService';
import { mapCdekStatusToInternalDeliveryState } from '../services/cdekStatusMapper';

const SYNC_INTERVAL_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

// Маппинг статусов CDEK -> внутренний статус заказа
// https://api.cdek.ru/v2/statuses
export const mapCdekStatus = (code: string) => mapCdekStatusToInternalDeliveryState(code);

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

      await cdekWebhookService.applyIncomingStatus({
        entity: {
          uuid: info.cdekOrderId,
          cdek_number: info.trackingNumber
        },
        status: { code: newCdekStatus, name: newCdekStatus },
        source: 'sync_job',
        rawSnapshot: info.raw
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
