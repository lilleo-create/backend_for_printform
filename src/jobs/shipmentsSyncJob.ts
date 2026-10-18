import { prisma } from '../lib/prisma';
import { cdekWebhookService } from '../services/cdekWebhookService';
import { mapCdekStatusToInternalDeliveryState } from '../services/cdekStatusMapper';

const SYNC_INTERVAL_MS = 10 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export const mapCdekStatus = mapCdekStatusToInternalDeliveryState;

export const runShipmentsSyncJob = async () => {
  const result = await cdekWebhookService.syncCdekStatusesForActiveOrders();
  console.info('[SHIPMENTS_SYNC_JOB][CDEK]', result);
  return result;
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
  if (process.env.NODE_ENV === 'test' || timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    runShipmentsSyncJob()
      .catch((error) => console.error('[SHIPMENTS_SYNC_JOB] failed', error))
      .finally(() => { running = false; });
  }, SYNC_INTERVAL_MS);
  console.info('[SHIPMENTS_SYNC_JOB][START]', { intervalMs: SYNC_INTERVAL_MS });
};
