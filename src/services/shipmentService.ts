import { randomUUID } from 'node:crypto';
import type { Order, OrderShipment, Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { cdekService, type CdekOrderSnapshot } from './cdekService';
import { cdekWebhookService } from './cdekWebhookService';
import { mapCdekStatusToShipmentStatus } from './cdekStatusMapper';
import { BUYER_SHIPMENT_SELECT } from '../utils/serializers';
import { toCdekPackedParcel, validatePackedParcel, type ShippingSnapshot } from './shippingPackageService';
import { resolveCdekRecipient, resolveCdekSender } from './cdekShipmentContacts';

export type ShipmentInternalStatus =
  | 'CREATED'
  | 'VALIDATING'
  | 'READY_TO_SHIP'
  | 'IN_TRANSIT'
  | 'DELIVERED'
  | 'CANCELLED'
  | 'FAILED';

export type LabelPdfResolveResult =
  | { status: 'ready'; pdf: Buffer }
  | { status: 'processing' }
  | { status: 'need_ready_to_ship' }
  | { status: 'invalid'; reason?: string };

const FINAL_STATUSES: ShipmentInternalStatus[] = ['DELIVERED', 'CANCELLED', 'FAILED'];
const CDEK_PVZ_CODE_REGEX = /^[A-Z0-9]{3,20}$/;

export const normalizeCdekPvzCode = (value: unknown) => String(value ?? '').trim().toUpperCase();
export const isValidCdekPvzCode = (value: unknown) => CDEK_PVZ_CODE_REGEX.test(normalizeCdekPvzCode(value));

export const mapExternalStatusToInternal = (status?: string | null): ShipmentInternalStatus => {
  return mapCdekStatusToShipmentStatus(status ?? '') as ShipmentInternalStatus;
};

const ensureShipmentTables = async () => undefined;

const toJson = (value: Record<string, unknown> | undefined): Prisma.InputJsonObject | undefined =>
  value ? (value as Prisma.InputJsonObject) : undefined;

const makeError = (code: string, message?: string) => {
  const error = new Error(message ?? code) as Error & { code: string };
  error.code = code;
  return error;
};

const safeRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const parsePvzProvider = (meta: unknown) => String(safeRecord(meta).provider ?? '').trim().toUpperCase();

export const normalizePvzProvider = async <T extends Pick<Order, 'id' | 'carrier' | 'buyerPickupPvzId' | 'buyerPickupPvzMeta'>>(order: T) => {
  const carrier = String(order.carrier ?? '').toUpperCase();
  const pvzId = normalizeCdekPvzCode(order.buyerPickupPvzId);
  const currentProvider = parsePvzProvider(order.buyerPickupPvzMeta);

  if (carrier !== 'CDEK' || !isValidCdekPvzCode(pvzId) || currentProvider === 'CDEK') {
    return order;
  }

  const nextMeta = {
    ...safeRecord(order.buyerPickupPvzMeta),
    provider: 'CDEK',
    pvzId
  };

  await prisma.order.update({
    where: { id: order.id },
    data: { buyerPickupPvzMeta: nextMeta as unknown as Prisma.InputJsonValue }
  });

  return { ...order, buyerPickupPvzMeta: nextMeta };
};

const buildStatusRaw = (snapshot: CdekOrderSnapshot, fallbackUuid: string, orderNumber: string) => ({
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

const parseRelatedEntityUrls = (value: unknown) => {
  const entries = Array.isArray(value) ? value : [];
  const findType = (entry: unknown) => String(safeRecord(entry).type ?? '').trim().toLowerCase();
  const findUrl = (entry: unknown) => String(safeRecord(entry).url ?? '').trim();
  const waybillAliases = new Set(['waybill', 'waybill_url', 'waybillurl']);
  const barcodeAliases = new Set(['barcode', 'barcode_url', 'barcodeurl']);

  const resolvedWaybill =
    entries
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

const syncShipmentByOrder = async (orderId: string) => {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { shipment: true } });
  if (!order) throw makeError('ORDER_NOT_FOUND');

  const cdekOrderUuid = String(order.cdekOrderId ?? '').trim() || String((order.shipment?.statusRaw as any)?.cdek_order_uuid ?? '').trim();
  if (!cdekOrderUuid) throw makeError('CDEK_ORDER_UUID_MISSING');

  const snapshot = await cdekService.getOrderByUuid(cdekOrderUuid);
  await cdekWebhookService.applyVerifiedCdekStatus(orderId, snapshot);
  const shipment = await prisma.orderShipment.findUnique({ where: { orderId } });
  if (!shipment) throw makeError('SHIPMENT_NOT_FOUND');
  return { shipment, snapshot };
};

const loadOrderForCdekShipment = async (orderId: string, sellerId?: string) => {
  let order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { product: { include: { seller: { include: { sellerProfile: true } } } }, variant: true } },
      buyer: { select: BUYER_SHIPMENT_SELECT },
      contact: true
    }
  });

  if (!order) throw makeError('ORDER_NOT_FOUND');
  const sellerIds = [...new Set(order.items.map(item => item.product.sellerId))];
  if (sellerIds.length !== 1) throw makeError('MULTI_SELLER_CHECKOUT_NOT_SUPPORTED');
  if (sellerId && sellerIds[0] !== sellerId) throw makeError('ORDER_NOT_FOUND');
  const isPaid = order.paymentStatus === 'PAID' && Boolean(order.paidAt);
  if (!isPaid) throw makeError('ORDER_NOT_PAID');
  if (order.status === 'PAID') throw makeError('PRODUCTION_NOT_STARTED');
  if (['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED'].includes(order.paymentStatus) ||
    !['PRINTING', 'READY_FOR_SHIPMENT'].includes(order.status)) {
    throw makeError('SELLER_SHIPMENT_STATUS_LOCKED');
  }
  order = await normalizePvzProvider(order);
  const fulfillment = order as Order & { isPacked?: boolean };
  if (!fulfillment.isPacked) {
    throw makeError('FULFILLMENT_STEPS_INCOMPLETE', 'Перед отгрузкой отметьте: Упаковка.');
  }
  if (!order.packedWeightGrams || !order.packedLengthCm || !order.packedWidthCm ||
      !order.packedHeightCm || !order.packedDeliveryAmountKopecks || !order.packedQuoteCalculatedAt) {
    throw makeError('PACKED_PARCEL_REQUIRED');
  }

  const fromPvzCodeRaw = String(order.sellerDropoffPvzId ?? '');
  const toPvzCodeRaw = String(order.buyerPickupPvzId ?? '');
  const fromPvzCode = normalizeCdekPvzCode(fromPvzCodeRaw);
  const toPvzCode = normalizeCdekPvzCode(toPvzCodeRaw);
  if (!fromPvzCode) throw makeError('CDEK_DROPOFF_PVZ_NOT_SET');
  if (!toPvzCode) throw makeError('CDEK_DESTINATION_PVZ_MISSING');

  const sellerProvider = parsePvzProvider(order.sellerDropoffPvzMeta);
  if (sellerProvider && sellerProvider !== 'CDEK') throw makeError('CDEK_DROPOFF_PVZ_PROVIDER_MISMATCH');
  const buyerProvider = parsePvzProvider(order.buyerPickupPvzMeta);
  if (buyerProvider && buyerProvider !== 'CDEK') {
    throw makeError('CDEK_DESTINATION_PVZ_PROVIDER_MISMATCH', `buyerPickupPvzMeta.provider must be CDEK for carrier CDEK (got ${buyerProvider})`);
  }

  const recipient = resolveCdekRecipient(
    String(order.recipientName ?? '').trim() || String(order.contact?.name ?? '').trim() || String(order.buyer?.name ?? '').trim(),
    String(order.recipientPhone ?? '').trim() || String(order.contact?.phone ?? '').trim() || String(order.buyer?.phone ?? '').trim()
  );

  if (!order.shippingSnapshot) throw makeError('SHIPPING_SNAPSHOT_MISSING');
  const snapshot = order.shippingSnapshot as ShippingSnapshot;
  const shippingPackage = toCdekPackedParcel(validatePackedParcel({
    weightGrams: order.packedWeightGrams,
    lengthCm: order.packedLengthCm,
    widthCm: order.packedWidthCm,
    heightCm: order.packedHeightCm
  }, snapshot));
  const snapshotByProduct = new Map<string, { quantity: number; weight: number }>();
  for (const entry of snapshot.items) {
    const previous = snapshotByProduct.get(entry.productId);
    if (previous && previous.weight !== entry.weightGrossG) throw makeError('SHIPPING_SNAPSHOT_INVALID');
    snapshotByProduct.set(entry.productId, {
      quantity: (previous?.quantity ?? 0) + entry.quantity,
      weight: entry.weightGrossG
    });
  }
  const orderQuantityByProduct = new Map<string, number>();
  for (const item of order.items) {
    orderQuantityByProduct.set(item.productId, (orderQuantityByProduct.get(item.productId) ?? 0) + item.quantity);
  }
  if (snapshotByProduct.size !== orderQuantityByProduct.size ||
    [...orderQuantityByProduct].some(([productId, quantity]) => snapshotByProduct.get(productId)?.quantity !== quantity)) {
    throw makeError('SHIPPING_SNAPSHOT_INVALID');
  }
  const items = order.items.map((item) => ({
    id: item.id,
    name: item.product.title,
    article: item.variant?.sku ?? item.product.sku,
    price: item.priceAtPurchase,
    quantity: item.quantity,
    weight: snapshotByProduct.get(item.productId)?.weight ?? 0,
  }));
  if (items.some(item => !item.weight) ||
    items.reduce((sum, item) => sum + item.weight * item.quantity, 0) > shippingPackage.weightGrams) {
    throw makeError('SHIPPING_SNAPSHOT_INVALID');
  }

  return {
    order,
    fromPvzCodeRaw,
    toPvzCodeRaw,
    fromPvzCode,
    toPvzCode,
    recipientName: recipient.recipientName,
    recipientPhone: recipient.recipientPhone,
    seller: order.items[0].product.seller,
    items,
    shippingPackage
  };
};

export const createShipmentCdek = async (orderId: string, sellerId?: string) => {
  const {
    order,
    fromPvzCodeRaw,
    toPvzCodeRaw,
    fromPvzCode,
    toPvzCode,
    recipientName,
    recipientPhone,
    seller,
    items,
    shippingPackage
  } = await loadOrderForCdekShipment(orderId, sellerId);

  const existingShipment = await prisma.orderShipment.findUnique({ where: { orderId: order.id } });
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

  const { senderName, senderPhone } = resolveCdekSender(seller);

  const internalRequestId = randomUUID();
  const now = new Date();
  let createdCdekOrderId: string | null = null;
  let shipmentCommitted = false;

  try {
    if (!isValidCdekPvzCode(fromPvzCode)) {
      console.warn('[CDEK][createShipmentCdek] invalid dropoff pvz code', {
        orderId: order.id,
        field: 'sellerDropoffPvzId',
        dropoffPvzCodeRaw: fromPvzCodeRaw,
        dropoffPvzCodeNormalized: fromPvzCode
      });
      throw makeError('CDEK_DROPOFF_PVZ_INVALID_FORMAT');
    }
    if (!isValidCdekPvzCode(toPvzCode)) {
      console.warn('[CDEK][createShipmentCdek] invalid destination pvz code', {
        orderId: order.id,
        field: 'buyerPickupPvzId',
        destinationPvzCodeRaw: toPvzCodeRaw,
        destinationPvzCodeNormalized: toPvzCode
      });
      throw makeError('CDEK_DESTINATION_PVZ_INVALID_FORMAT');
    }

    const created = await cdekService.createOrderFromMarketplaceOrder({
      orderId: order.id,
      fromPvzCode,
      toPvzCode,
      recipientName,
      recipientPhone,
      senderName,
      senderPhone,
      items,
      comment: `Order ${order.id}`,
      weightGrams: shippingPackage.weightGrams,
      lengthCm: shippingPackage.lengthCm,
      widthCm: shippingPackage.widthCm,
      heightCm: shippingPackage.heightCm
    });

    if (!created.cdekOrderId) throw makeError('CDEK_CREATE_ORDER_NO_UUID');
    createdCdekOrderId = created.cdekOrderId;

    const statusRaw = {
      cdek_order_number: order.id,
      cdek_order_uuid: created.cdekOrderId,
      cdek_request_uuid: created.cdekRequestUuid ?? '',
      cdek_state: created.state ?? '',
      trackingNumber: created.trackingNumber ?? ''
    };

    const shipment = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      const current = await tx.order.findUnique({ where: { id: order.id }, include: { shipment: true } });
      if (!current || !['PRINTING', 'READY_FOR_SHIPMENT'].includes(current.status) ||
        current.paymentStatus !== 'PAID' || !current.paidAt || !current.isPacked ||
        current.packedWeightGrams !== order.packedWeightGrams ||
        current.packedLengthCm !== order.packedLengthCm || current.packedWidthCm !== order.packedWidthCm ||
        current.packedHeightCm !== order.packedHeightCm ||
        current.packedDeliveryAmountKopecks !== order.packedDeliveryAmountKopecks ||
        ['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED'].includes(current.paymentStatus) ||
        (current.readyForShipmentAt && current.status !== 'READY_FOR_SHIPMENT') ||
        current.shipment || current.cdekOrderId) {
        throw makeError('SELLER_SHIPMENT_STATUS_LOCKED');
      }
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
          cdekOrderUuid: created.cdekOrderId,
          cdekNumber: created.trackingNumber || null,
          cdekStatus: created.state || 'ACCEPTED',
          deliveryProvider: 'CDEK',
          deliveryStatusCode: created.state || 'ACCEPTED',
          trackingNumber: created.trackingNumber || null
        }
      });

      await tx.orderShipmentStatusHistory.create({
        data: { shipmentId: nextShipment.id, status: 'READY_TO_SHIP', payloadRaw: statusRaw }
      });

      return nextShipment;
    });
    shipmentCommitted = true;

    let synced: Awaited<ReturnType<typeof syncShipmentByOrder>> | null = null;
    try {
      synced = await syncShipmentByOrder(order.id);
    } catch (syncError) {
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
  } catch (error) {
    if (createdCdekOrderId && !shipmentCommitted) {
      try {
        await cdekService.deleteOrder(createdCdekOrderId);
      } catch (cleanupError) {
        console.error('[CDEK][createShipmentCdek] orphan cleanup failed', {
          orderId: order.id, code: (cleanupError as { code?: string }).code ?? 'CDEK_DELETE_FAILED'
        });
      }
    }
    console.error('[CDEK][createShipmentCdek] failed', { orderId: order.id, error });
    throw error;
  }
};

export const markReadyToShipCdek = async (orderId: string, sellerId?: string) => {
  const { order } = await loadOrderForCdekShipment(orderId, sellerId);

  const existingShipment = await prisma.orderShipment.findUnique({ where: { orderId: order.id } });
  if (order.readyForShipmentAt && existingShipment && order.cdekOrderId) {
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
  if ((order.sellerNetAmountKopecks ?? order.total) < order.packedDeliveryAmountKopecks!) {
    throw makeError('DELIVERY_COST_EXCEEDS_SELLER_NET');
  }
  let cdekOrderId = String(order.cdekOrderId ?? '').trim() || null;
  let trackingNumber = order.trackingNumber;
  let cdekState = order.cdekStatus;

  if (!existingShipment || !cdekOrderId) {
    const created = await createShipmentCdek(orderId, sellerId);
    cdekOrderId = created.cdek.cdekOrderId ?? cdekOrderId;
    trackingNumber = created.cdek.trackingNumber ?? trackingNumber;
    cdekState = created.cdek.state ?? cdekState;
  }

  const shipmentForOrder = await prisma.orderShipment.findUnique({ where: { orderId: order.id } });
  if (!shipmentForOrder || !cdekOrderId) {
    throw makeError('SHIPMENT_NOT_FOUND', 'Сначала нажмите «Готов к отгрузке».');
  }

  const now = new Date();

  const shipment = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
    const current = await tx.order.findUnique({ where: { id: order.id }, include: { shipment: true } });
    if (!current || !['PRINTING', 'READY_FOR_SHIPMENT'].includes(current.status) ||
      current.paymentStatus !== 'PAID' || !current.paidAt || !current.isPacked ||
      !current.packedWeightGrams || !current.packedLengthCm || !current.packedWidthCm ||
      !current.packedHeightCm || !current.packedDeliveryAmountKopecks ||
      ['REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'CANCELLED'].includes(current.paymentStatus)) {
      throw makeError('SELLER_SHIPMENT_STATUS_LOCKED');
    }
    if (current.readyForShipmentAt && current.shipment) return current.shipment;
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
        dropoffDeadlineAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        status: 'READY_FOR_SHIPMENT' as any,
        statusUpdatedAt: now,
        cdekOrderId: cdekOrderId,
        cdekOrderUuid: cdekOrderId,
        cdekNumber: trackingNumber || null,
        cdekStatus: cdekState || undefined,
        deliveryProvider: 'CDEK',
        deliveryStatusCode: cdekState || undefined,
        trackingNumber: trackingNumber || undefined
      }
    });

    await tx.orderShipmentStatusHistory.create({
      data: { shipmentId: nextShipment.id, status: 'READY_TO_SHIP', payloadRaw: { source: 'seller-ready-to-ship' } }
    });

    return nextShipment;
  });

  let synced: Awaited<ReturnType<typeof syncShipmentByOrder>> | null = null;
  try {
    synced = await syncShipmentByOrder(order.id);
  } catch (syncError) {
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

export const shipmentService = {
  ensure: ensureShipmentTables,
  normalizePvzProvider,
  isFinalStatus: (status: ShipmentInternalStatus) => FINAL_STATUSES.includes(status),

  getByOrderIds: async (orderIds: string[]): Promise<Map<string, OrderShipment>> => {
    await ensureShipmentTables();
    if (!orderIds.length) return new Map<string, OrderShipment>();

    const orders = await prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, carrier: true, buyerPickupPvzId: true, buyerPickupPvzMeta: true } });
    await Promise.all(orders.map((order) => normalizePvzProvider(order as any)));

    const shipments = await prisma.orderShipment.findMany({ where: { orderId: { in: orderIds } } });
    return new Map(shipments.map((shipment) => [shipment.orderId, shipment]));
  },

  getByOrderId: async (orderId: string) => {
    await ensureShipmentTables();
    return prisma.orderShipment.findUnique({ where: { orderId } });
  },

  getById: async (shipmentId: string) => {
    await ensureShipmentTables();
    return prisma.orderShipment.findUnique({ where: { id: shipmentId } });
  },

  readyToShipCdek: async (params: { orderId: string; sellerId: string }) => {
    void params.sellerId;
    return markReadyToShipCdek(params.orderId, params.sellerId);
  },

  createShipmentCdek: async (params: { orderId: string; sellerId: string }) => {
    return createShipmentCdek(params.orderId, params.sellerId);
  },

  syncByShipmentId: async (shipmentId: string) => {
    const shipment = await prisma.orderShipment.findUnique({ where: { id: shipmentId } });
    if (!shipment) throw makeError('SHIPMENT_NOT_FOUND');
    return syncShipmentByOrder(shipment.orderId);
  },

  syncByOrderId: async (orderId: string) => syncShipmentByOrder(orderId),

  ensureLabelBarcodePrintTask: async (params: {
    shipmentId: string;
    cdekOrderId: string;
    labelPrintRequestUuid?: string | null;
  }) => {
    const cdekOrderId = String(params.cdekOrderId ?? '').trim();
    if (!cdekOrderId) throw makeError('CDEK_ORDER_UUID_MISSING');

    const existingUuid = String(params.labelPrintRequestUuid ?? '').trim();
    if (existingUuid) {
      console.info('[shipmentService.ensureLabelBarcodePrintTask] reuse existing barcode print task', {
        shipmentId: params.shipmentId,
        cdekOrderId,
        printTaskUuid: existingUuid
      });
      return existingUuid;
    }

    const printTaskUuid = await cdekService.createBarcodePrintTaskForLabel({
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

    await prisma.orderShipment.update({
      where: { id: params.shipmentId },
      data: { labelPrintRequestUuid: printTaskUuid }
    });

    return printTaskUuid;
  },

  resolveLabelBarcodePdf: async (params: {
    shipmentId: string;
    cdekOrderId: string;
    labelPrintRequestUuid?: string | null;
  }): Promise<LabelPdfResolveResult> => {
    const cdekOrderId = String(params.cdekOrderId ?? '').trim();
    if (!cdekOrderId) return { status: 'need_ready_to_ship' as const };

    let printTaskUuid = await shipmentService.ensureLabelBarcodePrintTask({
      shipmentId: params.shipmentId,
      cdekOrderId,
      labelPrintRequestUuid: params.labelPrintRequestUuid
    });

    const loadSnapshot = async (requestUuid: string) => {
      const snapshot = await cdekService.getBarcodePrintTaskForLabel(requestUuid);
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
      printTaskUuid = await cdekService.createBarcodePrintTaskForLabel({
        orderUuids: [cdekOrderId],
        copyCount: 1,
        format: 'A4',
        lang: 'RUS'
      });

      await prisma.orderShipment.update({
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
        const pdf = await cdekService.downloadBarcodePdf(printTaskUuid);
        console.info('[CDEK][label][downloadByPrintUuid]', {
          shipmentId: params.shipmentId,
          requestUuid: printTaskUuid,
          size: pdf.length
        });
        return { status: 'ready' as const, pdf };
      } catch (error: any) {
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
      return { status: 'invalid' as const, reason: 'CDEK barcode print task is INVALID' };
    }

    const orderSnapshot = await cdekService.getOrderInfo(cdekOrderId);
    const parsedRelatedEntities = orderSnapshot.relatedEntities;
    const barcodeUrl = parsedRelatedEntities?.barcodeUrls?.[0] ?? null;

    console.info('[CDEK][label][candidateSources]', {
      shipmentId: params.shipmentId,
      barcodeUrl,
    });

    // Only use barcode URL — waybill URLs are the act/handover document, not the label sticker
    const candidateUrl = barcodeUrl ?? null;
    if (candidateUrl) {
      try {
        console.info('[CDEK][label][downloadByUrl][start]', { shipmentId: params.shipmentId, url: candidateUrl });
        const pdf = await cdekService.downloadPdfByUrl(candidateUrl);
        console.info('[CDEK][label][downloadByUrl][response]', {
          shipmentId: params.shipmentId,
          url: candidateUrl,
          size: pdf.length
        });
        return { status: 'ready' as const, pdf };
      } catch (error: any) {
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
      return { status: 'processing' as const };
    }

    return { status: 'invalid' as const, reason: `Unexpected print task status: ${snapshot.status}` };
  },

  getPrintableFormsByOrderId: async (orderId: string) => {
    const shipment = await prisma.orderShipment.findUnique({ where: { orderId } });
    if (!shipment) throw makeError('SHIPMENT_NOT_FOUND');

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

  getPrintableForms: async (orderId: string) => {
    return shipmentService.getPrintableFormsByOrderId(orderId);
  }
};
