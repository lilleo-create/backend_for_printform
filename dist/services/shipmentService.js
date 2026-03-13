"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.shipmentService = exports.markReadyToShipCdek = exports.createShipmentCdek = exports.normalizePvzProvider = exports.mapExternalStatusToInternal = void 0;
const node_crypto_1 = require("node:crypto");
const prisma_1 = require("../lib/prisma");
const cdekService_1 = require("./cdekService");
const FINAL_STATUSES = ['DELIVERED', 'CANCELLED', 'FAILED'];
const CDEK_PVZ_CODE_REGEX = /^[A-Z]{3}\d{2,6}$/;
const mapExternalStatusToInternal = (status) => {
    const normalized = (status ?? '').toUpperCase();
    if (['DELIVERY_DELIVERED', 'DELIVERED'].includes(normalized))
        return 'DELIVERED';
    if (['CANCELLED', 'DELIVERY_CANCELLED', 'INVALID', 'REFUSED'].includes(normalized))
        return 'CANCELLED';
    if (['DRAFT', 'VALIDATING'].includes(normalized))
        return 'VALIDATING';
    if (['CREATED', 'ACCEPTED', 'READY_TO_SHIP'].includes(normalized))
        return 'READY_TO_SHIP';
    if (['READY_FOR_PICKUP', 'DELIVERY_ARRIVED_PICKUP_POINT', 'DELIVERY_TRANSPORTATION', 'IN_TRANSIT', 'DELIVERY_TRANSMITTED_TO_RECIPIENT'].includes(normalized)) {
        return 'IN_TRANSIT';
    }
    return 'CREATED';
};
exports.mapExternalStatusToInternal = mapExternalStatusToInternal;
const ensureShipmentTables = async () => undefined;
const toJson = (value) => value ? value : undefined;
const makeError = (code, message) => {
    const error = new Error(message ?? code);
    error.code = code;
    return error;
};
const safeRecord = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const parsePvzProvider = (meta) => String(safeRecord(meta).provider ?? '').trim().toUpperCase();
const normalizePvzProvider = async (order) => {
    const carrier = String(order.carrier ?? '').toUpperCase();
    const pvzId = String(order.buyerPickupPvzId ?? '').trim().toUpperCase();
    const currentProvider = parsePvzProvider(order.buyerPickupPvzMeta);
    if (carrier !== 'CDEK' || !CDEK_PVZ_CODE_REGEX.test(pvzId) || currentProvider === 'CDEK') {
        return order;
    }
    const nextMeta = {
        ...safeRecord(order.buyerPickupPvzMeta),
        provider: 'CDEK',
        pvzId
    };
    await prisma_1.prisma.order.update({
        where: { id: order.id },
        data: { buyerPickupPvzMeta: nextMeta }
    });
    return { ...order, buyerPickupPvzMeta: nextMeta };
};
exports.normalizePvzProvider = normalizePvzProvider;
const buildStatusRaw = (snapshot, fallbackUuid, orderNumber) => ({
    cdek_order_number: orderNumber,
    cdek_order_uuid: snapshot.cdekOrderId || fallbackUuid,
    cdek_request_uuid: snapshot.requestUuid || '',
    cdek_state: snapshot.status || '',
    trackingNumber: String(snapshot.trackingNumber ?? '').trim(),
    print: {
        waybillUrl: snapshot.relatedEntities.waybillUrl,
        barcodeUrls: snapshot.relatedEntities.barcodeUrls
    },
    related_entities: snapshot.raw.related_entities ?? []
});
const parseRelatedEntityUrls = (value) => {
    const entries = Array.isArray(value) ? value : [];
    const findType = (entry) => String(safeRecord(entry).type ?? '').trim().toLowerCase();
    const findUrl = (entry) => String(safeRecord(entry).url ?? '').trim();
    const waybillAliases = new Set(['waybill', 'waybill_url', 'waybillurl']);
    const barcodeAliases = new Set(['barcode', 'barcode_url', 'barcodeurl']);
    const resolvedWaybill = entries
        .map((entry) => ({ type: findType(entry), url: findUrl(entry) }))
        .find((entry) => waybillAliases.has(entry.type) && entry.url)?.url ?? null;
    const barcodeUrls = entries
        .map((entry) => ({ type: findType(entry), url: findUrl(entry) }))
        .filter((entry) => barcodeAliases.has(entry.type) && entry.url)
        .map((entry) => entry.url);
    return {
        waybillUrl: resolvedWaybill,
        barcodeUrls
    };
};
const syncShipmentByOrder = async (orderId) => {
    const order = await prisma_1.prisma.order.findUnique({ where: { id: orderId }, include: { shipment: true } });
    if (!order)
        throw makeError('ORDER_NOT_FOUND');
    const cdekOrderUuid = String(order.cdekOrderId ?? '').trim() || String(order.shipment?.statusRaw?.cdek_order_uuid ?? '').trim();
    if (!cdekOrderUuid)
        throw makeError('CDEK_ORDER_UUID_MISSING');
    const snapshot = await cdekService_1.cdekService.getOrderByUuid(cdekOrderUuid);
    const normalizedTrackingNumber = String(snapshot.trackingNumber ?? '').trim();
    const nextStatus = (0, exports.mapExternalStatusToInternal)(snapshot.status);
    const statusRaw = buildStatusRaw(snapshot, cdekOrderUuid, order.id);
    console.debug('[shipmentService.syncShipment] snapshot', {
        orderId,
        shipmentStatusRaw: snapshot.status,
        waybillUrl: snapshot.relatedEntities.waybillUrl,
        relatedEntities: snapshot.relatedEntities,
        rawRelatedEntities: snapshot.raw.related_entities ?? []
    });
    const updated = await prisma_1.prisma.$transaction(async (tx) => {
        const shipment = await tx.orderShipment.upsert({
            where: { orderId },
            create: {
                orderId,
                provider: 'CDEK',
                deliveryMethod: 'PICKUP_POINT',
                sourceStationId: String(order.sellerDropoffPvzId ?? ''),
                destinationStationId: String(order.buyerPickupPvzId ?? ''),
                requestId: snapshot.requestUuid || null,
                status: nextStatus,
                statusRaw,
                lastSyncAt: new Date()
            },
            update: {
                requestId: snapshot.requestUuid || undefined,
                status: nextStatus,
                statusRaw,
                lastSyncAt: new Date()
            }
        });
        await tx.order.update({
            where: { id: orderId },
            data: {
                cdekStatus: snapshot.status || undefined,
                cdekOrderId: snapshot.cdekOrderId || cdekOrderUuid,
                trackingNumber: normalizedTrackingNumber || null
            }
        });
        await tx.orderShipmentStatusHistory.create({
            data: {
                shipmentId: shipment.id,
                status: nextStatus,
                payloadRaw: statusRaw
            }
        });
        return shipment;
    });
    return { shipment: updated, snapshot };
};
const loadOrderForCdekShipment = async (orderId, sellerId) => {
    let order = await prisma_1.prisma.order.findUnique({
        where: { id: orderId },
        include: {
            items: { include: { product: true, variant: true } },
            buyer: true,
            contact: true
        }
    });
    if (!order)
        throw makeError('ORDER_NOT_FOUND');
    if (sellerId) {
        const hasAccess = order.items.some((item) => item.product.sellerId === sellerId);
        if (!hasAccess)
            throw makeError('ORDER_NOT_FOUND');
    }
    order = await (0, exports.normalizePvzProvider)(order);
    const latestPayment = await prisma_1.prisma.payment.findFirst({
        where: { orderId: order.id },
        orderBy: { createdAt: 'desc' },
        select: { status: true }
    });
    const isPaid = Boolean(order.paidAt) || latestPayment?.status === 'SUCCEEDED';
    if (!isPaid)
        throw makeError('ORDER_NOT_PAID');
    const fulfillment = order;
    if (!fulfillment.isPacked) {
        throw makeError('FULFILLMENT_STEPS_INCOMPLETE', 'Перед отгрузкой отметьте: Упаковка.');
    }
    const fromPvzCode = String(order.sellerDropoffPvzId ?? '').trim();
    const toPvzCode = String(order.buyerPickupPvzId ?? '').trim();
    if (!fromPvzCode)
        throw makeError('CDEK_DROPOFF_PVZ_NOT_SET');
    if (!toPvzCode)
        throw makeError('CDEK_DESTINATION_PVZ_MISSING');
    const buyerProvider = parsePvzProvider(order.buyerPickupPvzMeta);
    if (buyerProvider && buyerProvider !== 'CDEK') {
        throw makeError('CDEK_DESTINATION_PVZ_PROVIDER_MISMATCH', `buyerPickupPvzMeta.provider must be CDEK for carrier CDEK (got ${buyerProvider})`);
    }
    const recipientName = String(order.recipientName ?? '').trim() || String(order.contact?.name ?? '').trim() || String(order.buyer?.name ?? '').trim() || 'Получатель';
    const recipientPhone = String(order.recipientPhone ?? '').trim() || String(order.contact?.phone ?? '').trim() || String(order.buyer?.phone ?? '').trim();
    if (!recipientPhone)
        throw makeError('RECIPIENT_PHONE_REQUIRED');
    const items = order.items.map((item) => ({
        id: item.id,
        name: item.product.title,
        article: item.variant?.sku ?? item.product.sku,
        price: item.priceAtPurchase,
        quantity: item.quantity
    }));
    const totalWeight = order.items.reduce((sum, item) => sum + (item.product.weightGrossG ?? 0) * item.quantity, 0);
    const firstProduct = order.items[0]?.product;
    return {
        order,
        fromPvzCode,
        toPvzCode,
        recipientName,
        recipientPhone,
        items,
        totalWeight,
        firstProduct
    };
};
const createShipmentCdek = async (orderId, sellerId) => {
    const { order, fromPvzCode, toPvzCode, recipientName, recipientPhone, items, totalWeight, firstProduct } = await loadOrderForCdekShipment(orderId, sellerId);
    const existingShipment = await prisma_1.prisma.orderShipment.findUnique({ where: { orderId: order.id } });
    if (existingShipment || order.cdekOrderId) {
        return {
            shipment: existingShipment,
            cdek: {
                cdekOrderId: order.cdekOrderId,
                trackingNumber: order.trackingNumber,
                cdekRequestUuid: null,
                state: order.cdekStatus
            }
        };
    }
    const internalRequestId = (0, node_crypto_1.randomUUID)();
    const now = new Date();
    try {
        if (!CDEK_PVZ_CODE_REGEX.test(fromPvzCode))
            throw makeError('CDEK_DROPOFF_PVZ_INVALID_FORMAT');
        if (!CDEK_PVZ_CODE_REGEX.test(toPvzCode))
            throw makeError('CDEK_DESTINATION_PVZ_INVALID_FORMAT');
        const created = await cdekService_1.cdekService.createOrderFromMarketplaceOrder({
            orderId: order.id,
            fromPvzCode,
            toPvzCode,
            recipientName,
            recipientPhone,
            items,
            comment: `Order ${order.id}`,
            weightGrams: totalWeight > 0 ? totalWeight : undefined,
            lengthCm: firstProduct?.dxCm ?? undefined,
            widthCm: firstProduct?.dyCm ?? undefined,
            heightCm: firstProduct?.dzCm ?? undefined
        });
        if (!created.cdekOrderId)
            throw makeError('CDEK_CREATE_ORDER_NO_UUID');
        const statusRaw = {
            cdek_order_number: order.id,
            cdek_order_uuid: created.cdekOrderId,
            cdek_request_uuid: created.cdekRequestUuid ?? '',
            cdek_state: created.state ?? '',
            trackingNumber: created.trackingNumber ?? ''
        };
        const shipment = await prisma_1.prisma.$transaction(async (tx) => {
            const nextShipment = await tx.orderShipment.upsert({
                where: { orderId: order.id },
                create: {
                    orderId: order.id,
                    provider: 'CDEK',
                    deliveryMethod: 'PICKUP_POINT',
                    sourceStationId: fromPvzCode,
                    destinationStationId: toPvzCode,
                    requestId: internalRequestId,
                    status: 'READY_TO_SHIP',
                    statusRaw,
                    lastSyncAt: now
                },
                update: {
                    provider: 'CDEK',
                    deliveryMethod: 'PICKUP_POINT',
                    sourceStationId: fromPvzCode,
                    destinationStationId: toPvzCode,
                    requestId: internalRequestId,
                    status: 'READY_TO_SHIP',
                    statusRaw,
                    lastSyncAt: now
                }
            });
            await tx.order.update({
                where: { id: order.id },
                data: {
                    carrier: 'CDEK',
                    cdekOrderId: created.cdekOrderId,
                    cdekStatus: created.state || 'ACCEPTED',
                    trackingNumber: created.trackingNumber || null
                }
            });
            await tx.orderShipmentStatusHistory.create({
                data: { shipmentId: nextShipment.id, status: 'READY_TO_SHIP', payloadRaw: statusRaw }
            });
            return nextShipment;
        });
        let synced = null;
        try {
            synced = await syncShipmentByOrder(order.id);
        }
        catch (syncError) {
            console.warn('[CDEK][createShipmentCdek] immediate sync failed', { orderId: order.id, syncError });
        }
        return {
            shipment: synced?.shipment ?? shipment,
            cdek: {
                cdekOrderId: created.cdekOrderId,
                trackingNumber: synced?.snapshot.trackingNumber || created.trackingNumber,
                cdekRequestUuid: created.cdekRequestUuid,
                state: synced?.snapshot.status || created.state
            }
        };
    }
    catch (error) {
        console.error('[CDEK][createShipmentCdek] failed', { orderId: order.id, error });
        throw error;
    }
};
exports.createShipmentCdek = createShipmentCdek;
const markReadyToShipCdek = async (orderId, sellerId) => {
    const { order } = await loadOrderForCdekShipment(orderId, sellerId);
    const existingShipment = await prisma_1.prisma.orderShipment.findUnique({ where: { orderId: order.id } });
    let cdekOrderId = String(order.cdekOrderId ?? '').trim() || null;
    let trackingNumber = order.trackingNumber;
    let cdekState = order.cdekStatus;
    if (!existingShipment || !cdekOrderId) {
        const created = await (0, exports.createShipmentCdek)(orderId, sellerId);
        cdekOrderId = created.cdek.cdekOrderId ?? cdekOrderId;
        trackingNumber = created.cdek.trackingNumber ?? trackingNumber;
        cdekState = created.cdek.state ?? cdekState;
    }
    const shipmentForOrder = await prisma_1.prisma.orderShipment.findUnique({ where: { orderId: order.id } });
    if (!shipmentForOrder || !cdekOrderId) {
        throw makeError('SHIPMENT_NOT_FOUND', 'Сначала нажмите «Готов к отгрузке».');
    }
    const now = new Date();
    const shipment = await prisma_1.prisma.$transaction(async (tx) => {
        const nextShipment = await tx.orderShipment.update({
            where: { id: shipmentForOrder.id },
            data: {
                status: 'READY_TO_SHIP',
                lastSyncAt: now
            }
        });
        await tx.order.update({
            where: { id: order.id },
            data: {
                readyForShipmentAt: now,
                status: 'HANDED_TO_DELIVERY',
                statusUpdatedAt: now,
                cdekOrderId: cdekOrderId,
                cdekStatus: cdekState || undefined,
                trackingNumber: trackingNumber || undefined
            }
        });
        await tx.orderShipmentStatusHistory.create({
            data: { shipmentId: nextShipment.id, status: 'READY_TO_SHIP', payloadRaw: { source: 'seller-ready-to-ship' } }
        });
        return nextShipment;
    });
    let synced = null;
    try {
        synced = await syncShipmentByOrder(order.id);
    }
    catch (syncError) {
        console.warn('[CDEK][markReadyToShipCdek] immediate sync failed', { orderId: order.id, syncError });
    }
    return {
        shipment: synced?.shipment ?? shipment,
        cdek: {
            cdekOrderId,
            trackingNumber: synced?.snapshot.trackingNumber || trackingNumber,
            cdekRequestUuid: null,
            state: synced?.snapshot.status || cdekState
        }
    };
};
exports.markReadyToShipCdek = markReadyToShipCdek;
exports.shipmentService = {
    ensure: ensureShipmentTables,
    normalizePvzProvider: exports.normalizePvzProvider,
    isFinalStatus: (status) => FINAL_STATUSES.includes(status),
    getByOrderIds: async (orderIds) => {
        await ensureShipmentTables();
        if (!orderIds.length)
            return new Map();
        const orders = await prisma_1.prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, carrier: true, buyerPickupPvzId: true, buyerPickupPvzMeta: true } });
        await Promise.all(orders.map((order) => (0, exports.normalizePvzProvider)(order)));
        const shipments = await prisma_1.prisma.orderShipment.findMany({ where: { orderId: { in: orderIds } } });
        return new Map(shipments.map((shipment) => [shipment.orderId, shipment]));
    },
    getByOrderId: async (orderId) => {
        await ensureShipmentTables();
        return prisma_1.prisma.orderShipment.findUnique({ where: { orderId } });
    },
    getById: async (shipmentId) => {
        await ensureShipmentTables();
        return prisma_1.prisma.orderShipment.findUnique({ where: { id: shipmentId } });
    },
    readyToShipCdek: async (params) => {
        void params.sellerId;
        return (0, exports.markReadyToShipCdek)(params.orderId, params.sellerId);
    },
    createShipmentCdek: async (params) => {
        return (0, exports.createShipmentCdek)(params.orderId, params.sellerId);
    },
    syncByShipmentId: async (shipmentId) => {
        const shipment = await prisma_1.prisma.orderShipment.findUnique({ where: { id: shipmentId } });
        if (!shipment)
            throw makeError('SHIPMENT_NOT_FOUND');
        return syncShipmentByOrder(shipment.orderId);
    },
    syncByOrderId: async (orderId) => syncShipmentByOrder(orderId),
    ensureLabelBarcodePrintTask: async (params) => {
        const cdekOrderId = String(params.cdekOrderId ?? '').trim();
        if (!cdekOrderId)
            throw makeError('CDEK_ORDER_UUID_MISSING');
        const existingUuid = String(params.labelPrintRequestUuid ?? '').trim();
        if (existingUuid) {
            console.info('[shipmentService.ensureLabelBarcodePrintTask] reuse existing barcode print task', {
                shipmentId: params.shipmentId,
                cdekOrderId,
                printTaskUuid: existingUuid
            });
            return existingUuid;
        }
        const printTaskUuid = await cdekService_1.cdekService.createBarcodePrintTaskForLabel({
            orderUuids: [cdekOrderId],
            copyCount: 1,
            format: 'A4',
            lang: 'RUS'
        });
        console.info('[CDEK][label][createPrintTask]', {
            shipmentId: params.shipmentId,
            cdekOrderId,
            requestUuid: printTaskUuid
        });
        await prisma_1.prisma.orderShipment.update({
            where: { id: params.shipmentId },
            data: { labelPrintRequestUuid: printTaskUuid }
        });
        return printTaskUuid;
    },
    resolveLabelBarcodePdf: async (params) => {
        const cdekOrderId = String(params.cdekOrderId ?? '').trim();
        if (!cdekOrderId)
            return { status: 'need_ready_to_ship' };
        let printTaskUuid = await exports.shipmentService.ensureLabelBarcodePrintTask({
            shipmentId: params.shipmentId,
            cdekOrderId,
            labelPrintRequestUuid: params.labelPrintRequestUuid
        });
        const loadSnapshot = async (requestUuid) => {
            const snapshot = await cdekService_1.cdekService.getBarcodePrintTaskForLabel(requestUuid);
            console.info('[CDEK][label][getPrintTaskStatus]', {
                shipmentId: params.shipmentId,
                requestUuid,
                status: snapshot.status,
                raw: snapshot
            });
            return snapshot;
        };
        let snapshot = await loadSnapshot(printTaskUuid);
        if (snapshot.status === 'REMOVED') {
            printTaskUuid = await cdekService_1.cdekService.createBarcodePrintTaskForLabel({
                orderUuids: [cdekOrderId],
                copyCount: 1,
                format: 'A4',
                lang: 'RUS'
            });
            await prisma_1.prisma.orderShipment.update({
                where: { id: params.shipmentId },
                data: { labelPrintRequestUuid: printTaskUuid }
            });
            console.info('[CDEK][label][createPrintTask]', {
                shipmentId: params.shipmentId,
                cdekOrderId,
                requestUuid: printTaskUuid,
                recreatedFrom: params.labelPrintRequestUuid ?? null
            });
            snapshot = await loadSnapshot(printTaskUuid);
        }
        if (snapshot.status === 'READY') {
            try {
                const pdf = await cdekService_1.cdekService.downloadBarcodePdf(printTaskUuid);
                console.info('[CDEK][label][downloadByPrintUuid]', {
                    shipmentId: params.shipmentId,
                    requestUuid: printTaskUuid,
                    size: pdf.length
                });
                return { status: 'ready', pdf };
            }
            catch (error) {
                console.warn('[CDEK][label][downloadByPrintUuid][error]', {
                    shipmentId: params.shipmentId,
                    requestUuid: printTaskUuid,
                    message: String(error?.message ?? 'unknown_error')
                });
            }
        }
        if (snapshot.status === 'INVALID') {
            console.error('[CDEK][label][invalid]', {
                shipmentId: params.shipmentId,
                requestUuid: printTaskUuid,
                raw: snapshot
            });
            return { status: 'invalid', reason: 'CDEK barcode print task is INVALID' };
        }
        const orderSnapshot = await cdekService_1.cdekService.getOrderInfo(cdekOrderId);
        const shipment = await prisma_1.prisma.orderShipment.findUnique({ where: { id: params.shipmentId } });
        const statusRaw = safeRecord(shipment?.statusRaw);
        const printRaw = safeRecord(statusRaw.print);
        const parsedRelatedEntities = orderSnapshot.relatedEntities;
        const barcodeUrl = parsedRelatedEntities?.barcodeUrls?.[0] ?? null;
        const printWaybillUrl = String(printRaw.waybillUrl ?? '').trim() || null;
        const waybillUrl = parsedRelatedEntities?.waybillUrl ?? null;
        console.info('[CDEK][label][candidateSources]', {
            shipmentId: params.shipmentId,
            barcodeUrl,
            printWaybillUrl,
            waybillUrl
        });
        const candidateUrl = barcodeUrl ?? printWaybillUrl ?? waybillUrl ?? null;
        if (candidateUrl) {
            try {
                console.info('[CDEK][label][downloadByUrl][start]', { shipmentId: params.shipmentId, url: candidateUrl });
                const pdf = await cdekService_1.cdekService.downloadPdfByUrl(candidateUrl);
                console.info('[CDEK][label][downloadByUrl][response]', {
                    shipmentId: params.shipmentId,
                    url: candidateUrl,
                    size: pdf.length
                });
                return { status: 'ready', pdf };
            }
            catch (error) {
                console.error('[CDEK][label][downloadByUrl][error]', {
                    shipmentId: params.shipmentId,
                    url: candidateUrl,
                    status: Number(error?.response?.status ?? error?.status ?? 0),
                    data: error?.response?.data ?? error?.data,
                    message: String(error?.message ?? 'unknown_error')
                });
            }
        }
        if (snapshot.status === 'ACCEPTED' || snapshot.status === 'PROCESSING') {
            return { status: 'processing' };
        }
        return { status: 'invalid', reason: `Unexpected print task status: ${snapshot.status}` };
    },
    getPrintableFormsByOrderId: async (orderId) => {
        const shipment = await prisma_1.prisma.orderShipment.findUnique({ where: { orderId } });
        if (!shipment)
            throw makeError('SHIPMENT_NOT_FOUND');
        const statusRaw = safeRecord(shipment.statusRaw);
        const printRaw = safeRecord(statusRaw.print);
        const relatedEntities = parseRelatedEntityUrls(statusRaw.related_entities);
        const waybillUrl = String(printRaw.waybillUrl ?? '').trim() || relatedEntities.waybillUrl;
        const barcodeUrlsFromPrint = Array.isArray(printRaw.barcodeUrls) ? printRaw.barcodeUrls.map((entry) => String(entry ?? '').trim()).filter(Boolean) : [];
        const barcodeUrls = barcodeUrlsFromPrint.length ? barcodeUrlsFromPrint : relatedEntities.barcodeUrls;
        console.debug('[shipmentService.getPrintableFormsByOrderId] parsed', {
            orderId,
            waybillUrl,
            printWaybillUrl: printRaw.waybillUrl ?? null,
            rawRelatedEntities: statusRaw.related_entities ?? [],
            parsedRelatedEntities: relatedEntities,
            shipmentStatusRaw: shipment.statusRaw
        });
        return { waybillUrl, barcodeUrls, shipment };
    },
    getPrintableForms: async (orderId) => {
        return exports.shipmentService.getPrintableFormsByOrderId(orderId);
    }
};
