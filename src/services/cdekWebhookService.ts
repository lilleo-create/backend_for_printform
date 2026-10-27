import { prisma } from '../lib/prisma';
import { cdekService, type CdekOrderSnapshot } from './cdekService';
import { env } from '../config/env';
import {
  isCdekReceiptConfirmed,
  mapCdekStatusToInternalDeliveryState,
  mapCdekStatusToShipmentStatus,
  parseCdekOrderStatusPayload
} from './cdekStatusMapper';
import { orderCompletionService } from './orderCompletionService';
import type { Prisma } from '@prisma/client';

type OrderWithShipment = NonNullable<Awaited<ReturnType<typeof findOrder>>>;

const findOrder = (orderId: string) =>
  prisma.order.findUnique({ where: { id: orderId }, include: { shipment: true } });

const findOrderBySignal = async (parsed: ReturnType<typeof parseCdekOrderStatusPayload>) => {
  if (parsed.cdekOrderUuid) {
    const order = await prisma.order.findFirst({
      where: { OR: [{ cdekOrderId: parsed.cdekOrderUuid }, { cdekOrderUuid: parsed.cdekOrderUuid }] },
      include: { shipment: true }
    });
    if (order) return order;
  }
  if (parsed.cdekNumber) {
    const order = await prisma.order.findFirst({
      where: { OR: [{ trackingNumber: parsed.cdekNumber }, { cdekNumber: parsed.cdekNumber }] },
      include: { shipment: true }
    });
    if (order) return order;
  }
  if (parsed.imNumber) {
    return prisma.order.findFirst({
      where: { OR: [{ id: parsed.imNumber }, { publicNumber: parsed.imNumber }] },
      include: { shipment: true }
    });
  }
  return null;
};

const statusRank: Record<string, number> = {
  CREATED: 0,
  PAID: 1,
  READY_FOR_SHIPMENT: 2,
  PRINTING: 3,
  HANDED_TO_DELIVERY: 4,
  IN_TRANSIT: 5,
  DELIVERED: 6
};
const terminalStatuses = new Set(['DELIVERED', 'CANCELLED', 'RETURNED', 'EXPIRED']);

const nextOrderStatus = (current: string, deliveryState: string) => {
  if (terminalStatuses.has(current)) return null;
  const candidate = deliveryState === 'READY_FOR_PICKUP' ? 'IN_TRANSIT'
    : deliveryState === 'FAILED' || deliveryState === 'RETURNED' ? 'RETURNED'
    : deliveryState;
  if (candidate === 'CANCELLED' || candidate === 'RETURNED') return candidate;
  if (!(candidate in statusRank)) return null;
  return statusRank[candidate] >= (statusRank[current] ?? 0) && candidate !== current ? candidate : null;
};

const snapshotEventAt = (snapshot: CdekOrderSnapshot): Date | null => {
  const statuses = snapshot.raw.entity?.statuses ?? snapshot.raw.statuses ?? [];
  const dates = statuses
    .filter((entry) => entry.code === snapshot.status && entry.date_time)
    .map((entry) => new Date(String(entry.date_time)))
    .filter((date) => !Number.isNaN(date.valueOf()));
  return dates.length ? new Date(Math.max(...dates.map((date) => date.valueOf()))) : null;
};

const assertSnapshotMatchesOrder = (order: OrderWithShipment, snapshot: CdekOrderSnapshot) => {
  const knownUuid = order.cdekOrderId || order.cdekOrderUuid ||
    String((order.shipment?.statusRaw as Record<string, unknown> | null)?.cdek_order_uuid ?? '');
  const knownTracking = String(order.trackingNumber || order.cdekNumber || '').trim();
  const verifiedTracking = String(snapshot.trackingNumber || '').trim();
  if (!snapshot.cdekOrderId || !snapshot.status) throw new Error('CDEK_SNAPSHOT_INCOMPLETE');
  if (knownUuid && knownUuid !== snapshot.cdekOrderId) throw new Error('CDEK_UUID_MISMATCH');
  if (knownTracking && verifiedTracking && knownTracking !== verifiedTracking) {
    throw new Error('CDEK_TRACKING_MISMATCH');
  }
  if (!knownUuid && (!knownTracking || knownTracking !== verifiedTracking)) {
    throw new Error('CDEK_ORDER_IDENTITY_UNVERIFIED');
  }
};

const getVerifiedSnapshot = async (order: OrderWithShipment) => {
  const uuid = order.cdekOrderId || order.cdekOrderUuid ||
    String((order.shipment?.statusRaw as Record<string, unknown> | null)?.cdek_order_uuid ?? '');
  const snapshot = uuid
    ? await cdekService.getOrderByUuid(uuid)
    : await cdekService.getOrderByTracking(String(order.trackingNumber ?? order.cdekNumber ?? ''));
  assertSnapshotMatchesOrder(order, snapshot);
  return snapshot;
};

export const cdekWebhookService = {
  orderStatusWebhookUrl() {
    return `${env.backendUrl.replace(/\/$/, '')}/api/cdek/webhooks/order-status`;
  },

  async ensureCdekOrderStatusWebhook() {
    const url = this.orderStatusWebhookUrl();
    const result = await cdekService.ensureOrderStatusWebhook(url);
    console.info('[CDEK][webhook][ensure]', { url, created: result.created, webhookUuid: result.webhookUuid });
    return result;
  },

  async handleWebhookSignal(payload: unknown) {
    const parsed = parseCdekOrderStatusPayload(payload);
    const raw = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (raw.type !== 'ORDER_STATUS') return { accepted: false, skipped: 'EVENT_TYPE_INVALID' as const };
    if (!parsed.statusCode || !(parsed.cdekOrderUuid || parsed.cdekNumber || parsed.imNumber)) {
      return { accepted: false, skipped: 'PAYLOAD_INVALID' as const };
    }

    const order = await findOrderBySignal(parsed);
    if (!order) return { accepted: true, skipped: 'ORDER_NOT_FOUND' as const };
    if (parsed.cdekOrderUuid && (order.cdekOrderId || order.cdekOrderUuid) &&
      parsed.cdekOrderUuid !== (order.cdekOrderId || order.cdekOrderUuid)) {
      return { accepted: true, skipped: 'SIGNAL_UUID_MISMATCH' as const };
    }
    if (parsed.cdekNumber && (order.trackingNumber || order.cdekNumber) &&
      parsed.cdekNumber !== (order.trackingNumber || order.cdekNumber)) {
      return { accepted: true, skipped: 'SIGNAL_TRACKING_MISMATCH' as const };
    }
    const snapshot = await getVerifiedSnapshot(order);
    if (parsed.cdekOrderUuid && parsed.cdekOrderUuid !== snapshot.cdekOrderId) {
      return { accepted: true, skipped: 'SIGNAL_UUID_MISMATCH' as const };
    }
    if (parsed.cdekNumber && parsed.cdekNumber !== snapshot.trackingNumber) {
      return { accepted: true, skipped: 'SIGNAL_TRACKING_MISMATCH' as const };
    }
    return this.applyVerifiedCdekStatus(order.id, snapshot);
  },

  async syncCdekOrderStatus(orderId: string) {
    const order = await findOrder(orderId);
    if (!order) throw new Error('ORDER_NOT_FOUND');
    const snapshot = await getVerifiedSnapshot(order);
    return this.applyVerifiedCdekStatus(order.id, snapshot);
  },

  async syncCdekStatusesForActiveOrders(limit?: number) {
    const orders = await prisma.order.findMany({
      where: { cdekOrderId: { not: null }, status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED'] } },
      ...(limit ? { take: limit } : {}),
      select: { id: true }
    });
    let synced = 0;
    for (const order of orders) {
      try {
        await this.syncCdekOrderStatus(order.id);
        synced += 1;
      } catch (error) {
        console.error('[CDEK][sync][order][failed]', { orderId: order.id, error });
      }
    }
    return { total: orders.length, synced };
  },

  async applyVerifiedCdekStatus(orderId: string, snapshot: CdekOrderSnapshot) {
    const mappedState = mapCdekStatusToInternalDeliveryState(snapshot.status);
    if (mappedState === 'UNKNOWN') return { accepted: true, skipped: 'STATUS_UNKNOWN' as const };
    const shipmentStatus = mapCdekStatusToShipmentStatus(snapshot.status);
    const verifiedTracking = String(snapshot.trackingNumber ?? '').trim();
    const eventAt = snapshotEventAt(snapshot);
    const now = new Date();
    const result = await prisma.$transaction(async (tx) => {
      // Serialize webhook and polling updates for the same order, including completion and funds release.
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
      const order = await tx.order.findUnique({ where: { id: orderId }, include: { shipment: true } });
      if (!order) throw new Error('ORDER_NOT_FOUND');
      assertSnapshotMatchesOrder(order, snapshot);

      const nextStatus = nextOrderStatus(order.status, mappedState);
      const statusChanged = order.cdekStatus !== snapshot.status;
      const raw = {
        cdek_order_uuid: snapshot.cdekOrderId,
        cdek_state: snapshot.status,
        cdek_request_uuid: snapshot.requestUuid,
        trackingNumber: verifiedTracking,
        print: snapshot.relatedEntities,
        related_entities: snapshot.raw.related_entities ?? []
      };
      const shipment = await tx.orderShipment.upsert({
        where: { orderId },
        create: {
          orderId,
          provider: 'CDEK',
          deliveryMethod: 'PICKUP_POINT',
          sourceStationId: String(order.sellerDropoffPvzId ?? ''),
          destinationStationId: String(order.buyerPickupPvzId ?? ''),
          requestId: snapshot.requestUuid || null,
          status: shipmentStatus,
          statusRaw: raw,
          lastSyncAt: now
        },
        update: {
          status: shipmentStatus,
          statusRaw: raw,
          lastSyncAt: now
        }
      });
      await tx.order.update({
        where: { id: orderId },
        data: {
          cdekOrderId: snapshot.cdekOrderId,
          cdekOrderUuid: snapshot.cdekOrderId,
          cdekNumber: verifiedTracking || order.cdekNumber,
          trackingNumber: verifiedTracking || order.trackingNumber,
          cdekStatus: snapshot.status,
          deliveryProvider: 'CDEK',
          deliveryStatus: mappedState,
          deliveryStatusCode: snapshot.status,
          deliveryStatusRaw: snapshot.raw as Prisma.InputJsonValue,
          deliveryStatusUpdatedAt: eventAt ?? now,
          ...(nextStatus ? { status: nextStatus as typeof order.status, statusUpdatedAt: now } : {})
        }
      });

      if (order.shipment?.status !== shipmentStatus || statusChanged) {
        await tx.orderShipmentStatusHistory.create({
          data: { shipmentId: shipment.id, status: shipmentStatus, payloadRaw: raw }
        });
      }
      const existingEvent = await tx.orderDeliveryEvent.findFirst({
        where: { orderId, provider: 'CDEK', status: snapshot.status, timestampUtc: eventAt?.toISOString() ?? null }
      });
      if (!existingEvent && (statusChanged || eventAt)) {
        await tx.orderDeliveryEvent.create({
          data: {
            orderId,
            provider: 'CDEK',
            status: snapshot.status,
            description: mappedState,
            timestampUtc: eventAt?.toISOString(),
            raw: snapshot.raw as Prisma.InputJsonValue
          }
        });
      }
      if (isCdekReceiptConfirmed(snapshot.status) && !terminalStatuses.has(order.status)) {
        await tx.order.update({
          where: { id: orderId },
          data: { deliveredToRecipientAt: order.deliveredToRecipientAt ?? eventAt ?? now }
        });
        await orderCompletionService.completeOrderFromDeliveryReceipt(orderId, 'cdek_sync', tx);
        await orderCompletionService.releaseFundsForCompletedOrder(orderId, tx);
      }
      return { accepted: true, orderId, mappedState };
    });
    return result;
  }
};
