"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cdekWebhookService = void 0;
const prisma_1 = require("../lib/prisma");
const cdekService_1 = require("./cdekService");
const env_1 = require("../config/env");
const cdekStatusMapper_1 = require("./cdekStatusMapper");
const orderCompletionService_1 = require("./orderCompletionService");
const toOrderStatus = (deliveryState) => {
    if (deliveryState === 'READY_FOR_SHIPMENT')
        return 'READY_FOR_SHIPMENT';
    if (deliveryState === 'IN_TRANSIT' || deliveryState === 'READY_FOR_PICKUP')
        return 'IN_TRANSIT';
    if (deliveryState === 'DELIVERED')
        return 'DELIVERED';
    if (deliveryState === 'CANCELLED')
        return 'CANCELLED';
    if (deliveryState === 'RETURNED' || deliveryState === 'FAILED')
        return 'RETURNED';
    return undefined;
};
const findOrderByCdekIdentifiers = async (payload) => {
    if (payload.cdekOrderUuid) {
        const byUuid = await prisma_1.prisma.order.findFirst({ where: { cdekOrderId: payload.cdekOrderUuid } });
        if (byUuid)
            return byUuid;
    }
    if (payload.cdekNumber) {
        const byNumber = await prisma_1.prisma.order.findFirst({ where: { trackingNumber: payload.cdekNumber } });
        if (byNumber)
            return byNumber;
    }
    if (payload.imNumber) {
        const byInternal = await prisma_1.prisma.order.findFirst({ where: { OR: [{ id: payload.imNumber }, { publicNumber: payload.imNumber }] } });
        if (byInternal)
            return byInternal;
    }
    return null;
};
exports.cdekWebhookService = {
    orderStatusWebhookUrl() {
        return `${env_1.env.backendUrl.replace(/\/$/, '')}/api/cdek/webhooks/order-status`;
    },
    async ensureCdekOrderStatusWebhook() {
        const result = await cdekService_1.cdekService.ensureOrderStatusWebhook(this.orderStatusWebhookUrl());
        console.info('[CDEK][webhook][ensure]', {
            url: this.orderStatusWebhookUrl(),
            created: result.created,
            webhookUuid: result.webhookUuid
        });
        return result;
    },
    async syncCdekOrderStatus(orderId) {
        const order = await prisma_1.prisma.order.findUnique({ where: { id: orderId } });
        if (!order)
            throw new Error('ORDER_NOT_FOUND');
        if (!order.cdekOrderId && !order.trackingNumber)
            throw new Error('CDEK_IDENTIFIERS_MISSING');
        const snapshot = order.cdekOrderId
            ? await cdekService_1.cdekService.getOrderByUuid(order.cdekOrderId)
            : await cdekService_1.cdekService.getOrderByTracking(String(order.trackingNumber ?? ''));
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
        const orders = await prisma_1.prisma.order.findMany({
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
            }
            catch (error) {
                console.error('[CDEK][sync][order][failed]', { orderId: order.id, error });
            }
        }
        return { total: orders.length, synced };
    },
    async applyIncomingStatus(payload) {
        const parsed = (0, cdekStatusMapper_1.parseCdekOrderStatusPayload)(payload);
        if (!parsed.statusCode)
            return { accepted: true, skipped: 'STATUS_CODE_MISSING' };
        const order = await findOrderByCdekIdentifiers(parsed);
        if (!order) {
            console.warn('[CDEK][webhook][order-not-found]', {
                cdekOrderUuid: parsed.cdekOrderUuid,
                cdekNumber: parsed.cdekNumber,
                imNumber: parsed.imNumber
            });
            return { accepted: true, skipped: 'ORDER_NOT_FOUND' };
        }
        const mappedState = (0, cdekStatusMapper_1.mapCdekStatusToInternalDeliveryState)(parsed.statusCode);
        const nextOrderStatus = toOrderStatus(mappedState);
        await prisma_1.prisma.$transaction(async (tx) => {
            await tx.order.update({
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
                    raw: parsed.raw
                }
            });
            if ((0, cdekStatusMapper_1.isCdekReceiptConfirmed)(parsed.statusCode)) {
                await tx.order.update({ where: { id: order.id }, data: { deliveredToRecipientAt: parsed.eventAt ?? new Date() } });
                await orderCompletionService_1.orderCompletionService.completeOrderFromDeliveryReceipt(order.id, 'cdek_webhook', tx);
                await orderCompletionService_1.orderCompletionService.releaseFundsForCompletedOrder(order.id, tx);
            }
        });
        return { accepted: true, orderId: order.id, mappedState };
    }
};
