const CDEK_STATUS_LABELS: Record<string, string> = {
  CREATED: 'Заявка создана в СДЭК',
  ACCEPTED: 'Ожидает передачи на склад',
  RECEIVED_AT_SHIPMENT_WAREHOUSE: 'Принята на складе СДЭК',
  RECEIVED_AT_SOURCE_WAREHOUSE: 'Принята на складе отправки',
  READY_FOR_SHIPMENT_IN_SENDER_CITY: 'Готова к отправке',
  TAKEN_BY_TRANSPORTER_FROM_SENDER: 'Забрана курьером',
  SENT_TO_TRANSIT_CITY: 'Отправлена в транзитный город',
  ACCEPTED_IN_TRANSIT_CITY: 'На транзитном складе',
  ACCEPTED_AT_RECIPIENT_CITY_WAREHOUSE: 'На складе в городе получателя',
  DELIVERING: 'Передана курьеру',
  DELIVERY_TRANSPORTATION: 'В пути',
  IN_TRANSIT: 'В пути',
  READY_FOR_DELIVERY: 'Готова к выдаче',
  ACCEPTED_AT_PICK_UP_POINT: 'В пункте выдачи',
  DELIVERY_ARRIVED_PICKUP_POINT: 'Прибыла в ПВЗ',
  DELIVERY_TRANSMITTED_TO_RECIPIENT: 'Передана получателю',
  DELIVERED: 'Доставлена',
  DELIVERY_DELIVERED: 'Доставлена',
  RECIPIENT_GOT: 'Получена получателем',
  NOT_DELIVERED: 'Не доставлена',
  DELIVERY_PROBLEM: 'Проблема с доставкой',
  RETURNED: 'Возврат',
  RETURN_ORDERS_TRANSIT: 'Возврат в пути',
  RETURN_ORDERS_RECEIVED: 'Возврат принят',
  CANCELLED: 'Отменена',
  INVALID: 'Ошибка создания заказа',
  REMOVED: 'Удалена'
};

const INTERNAL_STATE_LABELS: Record<string, string> = {
  READY_FOR_SHIPMENT: 'Ожидает передачи в СДЭК',
  HANDED_TO_DELIVERY: 'Передана в СДЭК',
  IN_TRANSIT: 'В пути',
  READY_FOR_PICKUP: 'В пункте выдачи',
  DELIVERED: 'Доставлена',
  RETURNED: 'Возвращена',
  CANCELLED: 'Отменена',
  FAILED: 'Ошибка доставки',
  UNKNOWN: ''
};

export const cdekStatusLabel = (cdekStatus: string | null | undefined): string => {
  if (!cdekStatus) return '';
  return CDEK_STATUS_LABELS[String(cdekStatus).toUpperCase()] ?? String(cdekStatus);
};

export const internalDeliveryStateLabel = (deliveryStatus: string | null | undefined): string => {
  if (!deliveryStatus) return '';
  return INTERNAL_STATE_LABELS[String(deliveryStatus).toUpperCase()] ?? String(deliveryStatus);
};

export const resolveDeliveryStatusLabel = (order: {
  cdekStatus?: string | null;
  deliveryStatus?: string | null;
}): string => {
  if (order.cdekStatus) return cdekStatusLabel(order.cdekStatus);
  if (order.deliveryStatus) return internalDeliveryStateLabel(order.deliveryStatus);
  return '';
};
