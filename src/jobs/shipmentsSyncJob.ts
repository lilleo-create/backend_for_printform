import { prisma } from '../lib/prisma';
import { cdekWebhookService } from '../services/cdekWebhookService';
import { mapCdekStatusToInternalDeliveryState } from '../services/cdekStatusMapper';
import { safeCdekError } from '../services/safeCdekError';
import { recordJobRun } from '../services/operationalState';

const SYNC_INTERVAL_MS = 10 * 60 * 1000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export const mapCdekStatus = mapCdekStatusToInternalDeliveryState;

export const runShipmentsSyncJob = async () => {
  try {
    const result = await cdekWebhookService.syncCdekStatusesForActiveOrders();
    await recordJobRun('cdek-sync', { ok: true, counts: { total: result.total, synced: result.synced } });
    console.info('[SHIPMENTS_SYNC_JOB][CDEK]', result);
    return result;
  } catch (error) {
    await recordJobRun('cdek-sync', { ok: false }).catch(() => undefined);
    throw error;
  }
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
      .catch((error) => console.error('[SHIPMENTS_SYNC_JOB] failed', { error: safeCdekError(error, 'runShipmentsSyncJob') }))
      .finally(() => { running = false; });
  }, SYNC_INTERVAL_MS);
  console.info('[SHIPMENTS_SYNC_JOB][START]', { intervalMs: SYNC_INTERVAL_MS });
};
