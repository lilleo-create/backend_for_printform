import { prisma } from '../lib/prisma';
import { cdekService } from './cdekService';
import { env } from '../config/env';
import {
  isCdekReceiptConfirmed,
  mapCdekStatusToInternalDeliveryState,
  parseCdekOrderStatusPayload
} from './cdekStatusMapper';
import { orderCompletionService } from './orderCompletionService';
import type { Prisma } from '@prisma/client';

const toOrderStatus = (deliveryState: string): Prisma.OrderUpdateInput['status'] | undefined => {
  if (deliveryState === 'READY_FOR_SHIPMENT') return 'READY_FOR_SHIPMENT';
  if (deliveryState === 'IN_TRANSIT' || deliveryState === 'READY_FOR_PICKUP') return 'IN_TRANSIT';
  if (deliveryState === 'DELIVERED') return 'DELIVERED';
  if (deliveryState === 'CANCELLED') return 'CANCELLED';
  if (deliveryState === 'RETURNED' || deliveryState === 'FAILED') return 'RETURNED';
  return undefined;
};

const findOrderByCdekIdentifiers = async (payload: ReturnType<typeof parseCdekOrderStatusPayload>) => {
  if (payload.cdekOrderUuid) {
    const byUuid = await prisma.order.findFirst({ where: { cdekOrderId: payload.cdekOrderUuid } });
    if (byUuid) return byUuid;
  }

  if (payload.cdekNumber) {
    const byNumber = await prisma.order.findFirst({ where: { trackingNumber: payload.cdekNumber } });
    if (byNumber) return byNumber;
  }

  if (payload.imNumber) {
    const byInternal = await prisma.order.findFirst({ where: { OR: [{ id: payload.imNumber }, { publicNumber: payload.imNumber }] } });
    if (byInternal) return byInternal;
  }

  return null;
};

export const cdekWebhookService = {
  orderStatusWebhookUrl() {
    return `${env.backendUrl.replace(/\/$/, '')}/api/cdek/webhooks/order-status`;
  },

  async ensureCdekOrderStatusWebhook() {
    const result = await cdekService.ensureOrderStatusWebhook(this.orderStatusWebhookUrl());
    console.info('[CDEK][webhook][ensure]', {
      url: this.orderStatusWebhookUrl(),
      created: result.created,
      webhookUuid: result.webhookUuid
    });
    return result;
  },

  async syncCdekOrderStatus(orderId: string) {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error('ORDER_NOT_FOUND');
    if (!order.cdekOrderId && !order.trackingNumber) throw new Error('CDEK_IDENTIFIERS_MISSING');

    const snapshot = order.cdekOrderId
      ? await cdekService.getOrderByUuid(order.cdekOrderId)
      : await cdekService.getOrderByTracking(String(order.trackingNumber ?? ''));

    return this.applyIncomingStatus({
      entity: {
        uuid: snapshot.cdekOrderId,
        cdek_number: snapshot.trackingNumber,
        im_number: order.publicNumber
      },
      status: { code: snapshot.status, name: snapshot.status },
      date_time: new Date().toISOString(),
      source: 'sync',
      rawSnapshot: snapshot.raw
    });
  },

  async syncCdekStatusesForActiveOrders(limit = 100) {
    const orders = await prisma.order.findMany({
      where: {
        cdekOrderId: { not: null },
        status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED'] }
      },
      take: limit,
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

  async applyIncomingStatus(payload: unknown) {
    const parsed = parseCdekOrderStatusPayload(payload);
    if (!parsed.statusCode) return { accepted: true, skipped: 'STATUS_CODE_MISSING' as const };

    const order = await findOrderByCdekIdentifiers(parsed);
    if (!order) {
      console.warn('[CDEK][webhook][order-not-found]', {
        cdekOrderUuid: parsed.cdekOrderUuid,
        cdekNumber: parsed.cdekNumber,
        imNumber: parsed.imNumber
      });
      return { accepted: true, skipped: 'ORDER_NOT_FOUND' as const };
    }

    const mappedState = mapCdekStatusToInternalDeliveryState(parsed.statusCode);
    const nextOrderStatus = toOrderStatus(mappedState);

    await prisma.$transaction(async (tx) => {
      await (tx.order.update as any)({
        where: { id: order.id },
        data: {
          cdekOrderId: parsed.cdekOrderUuid ?? order.cdekOrderId,
          trackingNumber: parsed.cdekNumber ?? order.trackingNumber,
          cdekStatus: parsed.statusCode,
          deliveryProvider: 'CDEK',
          deliveryStatus: mappedState,
          deliveryStatusCode: parsed.statusCode,
          deliveryStatusRaw: parsed.raw,
          deliveryStatusUpdatedAt: parsed.eventAt ?? new Date(),
          ...(nextOrderStatus ? { status: nextOrderStatus, statusUpdatedAt: new Date() } : {})
        }
      });

      await tx.orderDeliveryEvent.create({
        data: {
          orderId: order.id,
          provider: 'CDEK',
          status: parsed.statusCode,
          description: parsed.statusName || mappedState,
          timestampUtc: parsed.eventAt?.toISOString(),
          raw: parsed.raw as Prisma.InputJsonValue
        }
      });

      if (isCdekReceiptConfirmed(parsed.statusCode)) {
        await (tx.order.update as any)({ where: { id: order.id }, data: { deliveredToRecipientAt: parsed.eventAt ?? new Date() } });
        await orderCompletionService.completeOrderFromDeliveryReceipt(order.id, 'cdek_webhook', tx);
        await orderCompletionService.releaseFundsForCompletedOrder(order.id, tx);
      }
    });

    return { accepted: true, orderId: order.id, mappedState };
  }
};
