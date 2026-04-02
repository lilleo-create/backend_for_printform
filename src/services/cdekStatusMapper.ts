export type InternalDeliveryState = 'READY_FOR_SHIPMENT' | 'HANDED_TO_DELIVERY' | 'IN_TRANSIT' | 'READY_FOR_PICKUP' | 'DELIVERED' | 'FAILED' | 'RETURNED' | 'CANCELLED' | 'UNKNOWN';

export type ParsedCdekOrderStatusEvent = {
  cdekOrderUuid: string | null;
  cdekNumber: string | null;
  imNumber: string | null;
  statusCode: string;
  statusName: string;
  eventAt: Date | null;
  raw: Record<string, unknown>;
};

const RECEIPT_CONFIRMED_CODES = new Set([
  'DELIVERED',
  'DELIVERY_DELIVERED',
  'RECIPIENT_GOT',
  'DELIVERED_TO_RECIPIENT'
]);

const READY_FOR_PICKUP_CODES = new Set([
  'READY_FOR_DELIVERY',
  'ACCEPTED_AT_PICK_UP_POINT',
  'READY_FOR_PICKUP',
  'DELIVERY_ARRIVED_PICKUP_POINT'
]);

const IN_TRANSIT_CODES = new Set([
  'ACCEPTED',
  'RECEIVED_AT_SHIPMENT_WAREHOUSE',
  'READY_FOR_SHIPMENT_IN_SENDER_CITY',
  'TAKEN_BY_TRANSPORTER_FROM_SENDER',
  'SENT_TO_TRANSIT_CITY',
  'ACCEPTED_IN_TRANSIT_CITY',
  'ACCEPTED_AT_RECIPIENT_CITY_WAREHOUSE',
  'DELIVERING',
  'DELIVERY_TRANSPORTATION',
  'IN_TRANSIT'
]);

const FAILURE_CODES = new Set(['NOT_DELIVERED', 'DELIVERY_PROBLEM', 'FAILED']);
const RETURN_CODES = new Set(['RETURNED', 'RETURN_ORDERS_TRANSIT', 'RETURN_ORDERS_RECEIVED']);
const CANCEL_CODES = new Set(['INVALID', 'REMOVED', 'CANCELLED', 'REFUSED']);

const readRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const readString = (...values: unknown[]) => {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
};

const readStatusNode = (raw: Record<string, unknown>) => {
  const status = readRecord(raw.status);
  return {
    code: readString(status.code, raw.code, raw.status_code).toUpperCase(),
    name: readString(status.name, raw.status_name, raw.status)
  };
};

export const parseCdekOrderStatusPayload = (payload: unknown): ParsedCdekOrderStatusEvent => {
  const raw = readRecord(payload);
  const entity = readRecord(raw.entity);
  const order = readRecord(raw.order);
  const { code, name } = readStatusNode(raw);

  const cdekOrderUuid = readString(entity.uuid, entity.order_uuid, order.uuid, order.order_uuid, raw.uuid) || null;
  const cdekNumber = readString(entity.cdek_number, order.cdek_number, raw.cdek_number) || null;
  const imNumber = readString(entity.im_number, entity.number, order.im_number, order.number, raw.number, raw.im_number) || null;
  const eventAtRaw = readString(raw.date_time, raw.event_date_time, raw.event_at, (readRecord(raw.status)).date_time);
  const eventAt = eventAtRaw ? new Date(eventAtRaw) : null;

  return {
    cdekOrderUuid,
    cdekNumber,
    imNumber,
    statusCode: code,
    statusName: name,
    eventAt: eventAt && !Number.isNaN(eventAt.valueOf()) ? eventAt : null,
    raw
  };
};

export const mapCdekStatusToInternalDeliveryState = (statusCode: string): InternalDeliveryState => {
  const code = String(statusCode ?? '').trim().toUpperCase();
  if (!code) return 'UNKNOWN';
  if (code === 'ACCEPTED') return 'HANDED_TO_DELIVERY';
  if (RECEIPT_CONFIRMED_CODES.has(code)) return 'DELIVERED';
  if (READY_FOR_PICKUP_CODES.has(code)) return 'READY_FOR_PICKUP';
  if (IN_TRANSIT_CODES.has(code)) return 'IN_TRANSIT';
  if (FAILURE_CODES.has(code)) return 'FAILED';
  if (RETURN_CODES.has(code)) return 'RETURNED';
  if (CANCEL_CODES.has(code)) return 'CANCELLED';
  if (code === 'CREATED') return 'READY_FOR_SHIPMENT';
  return 'UNKNOWN';
};

export const isCdekReceiptConfirmed = (statusCode: string) => RECEIPT_CONFIRMED_CODES.has(String(statusCode ?? '').trim().toUpperCase());
