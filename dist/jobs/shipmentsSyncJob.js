"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.startShipmentsSyncJob = exports.runShipmentSlaJob = exports.runShipmentsSyncJob = exports.mapCdekStatus = void 0;
const prisma_1 = require("../lib/prisma");
const cdekService_1 = require("../services/cdekService");
const cdekWebhookService_1 = require("../services/cdekWebhookService");
const cdekStatusMapper_1 = require("../services/cdekStatusMapper");
const SYNC_INTERVAL_MS = 10 * 60 * 1000;
let timer = null;
// Маппинг статусов CDEK -> внутренний статус заказа
// https://api.cdek.ru/v2/statuses
const mapCdekStatus = (code) => (0, cdekStatusMapper_1.mapCdekStatusToInternalDeliveryState)(code);
exports.mapCdekStatus = mapCdekStatus;
const runShipmentsSyncJob = async () => {
    // Синхронизируем только заказы с CDEK order id, которые ещё не завершены
    const orders = await prisma_1.prisma.order.findMany({
        where: {
            cdekOrderId: { not: null },
            status: { notIn: ['DELIVERED', 'CANCELLED', 'RETURNED'] }
        },
        select: { id: true, cdekOrderId: true, cdekStatus: true }
    });
    let synced = 0;
    for (const order of orders) {
        if (!order.cdekOrderId)
            continue;
        try {
            const info = await cdekService_1.cdekService.getOrderInfo(order.cdekOrderId);
            const newCdekStatus = info.status;
            if (!newCdekStatus || newCdekStatus === order.cdekStatus)
                continue;
            await cdekWebhookService_1.cdekWebhookService.applyIncomingStatus({
                entity: {
                    uuid: info.cdekOrderId,
                    cdek_number: info.trackingNumber
                },
                status: { code: newCdekStatus, name: newCdekStatus },
                source: 'sync_job',
                rawSnapshot: info.raw
            });
            synced++;
        }
        catch (error) {
            console.error('[SHIPMENTS_SYNC_JOB][CDEK] order sync failed', { orderId: order.id, error });
        }
    }
    console.info('[SHIPMENTS_SYNC_JOB][CDEK]', { total: orders.length, synced });
    return { total: orders.length, synced };
};
exports.runShipmentsSyncJob = runShipmentsSyncJob;
const runShipmentSlaJob = async () => {
    const result = await prisma_1.prisma.order.updateMany({
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
exports.runShipmentSlaJob = runShipmentSlaJob;
const startShipmentsSyncJob = () => {
    if (timer)
        return;
    timer = setInterval(() => {
        (0, exports.runShipmentsSyncJob)().catch((error) => {
            console.error('[SHIPMENTS_SYNC_JOB] failed', error);
        });
        (0, exports.runShipmentSlaJob)().catch((error) => {
            console.error('[SHIPMENT_SLA_JOB] failed', error);
        });
    }, SYNC_INTERVAL_MS);
};
exports.startShipmentsSyncJob = startShipmentsSyncJob;
