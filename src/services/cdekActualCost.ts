import { mapCdekStatusToInternalDeliveryState } from './cdekStatusMapper';

type DeliveryDetail = { delivery_sum?: unknown } | null;
type SnapshotWithCost = { status: string; raw: { entity?: { delivery_detail?: DeliveryDetail } } };

export const extractVerifiedCdekActualCostKopecks = (snapshot: SnapshotWithCost): number | null => {
  const state = mapCdekStatusToInternalDeliveryState(snapshot.status);
  if (!['HANDED_TO_DELIVERY', 'IN_TRANSIT', 'READY_FOR_PICKUP', 'DELIVERED', 'RETURNED'].includes(state)) {
    return null;
  }
  const detail = snapshot.raw.entity?.delivery_detail;
  if (!detail) return null;
  // total_sum is an order total and can include non-delivery amounts.
  const raw = detail.delivery_sum;
  const rubles = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  const kopecks = Math.round(rubles * 100);
  return Number.isFinite(rubles) && rubles > 0 && Number.isSafeInteger(kopecks) ? kopecks : null;
};
