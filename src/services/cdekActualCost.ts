import { mapCdekStatusToInternalDeliveryState } from './cdekStatusMapper';

type DeliveryDetail = { delivery_sum?: unknown; total_sum?: unknown } | null;
type SnapshotWithCost = { status: string; raw: { entity?: { delivery_detail?: DeliveryDetail } } };

const toKopecks = (raw: unknown): number | null => {
  const rubles = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  const kopecks = Math.round(rubles * 100);
  return Number.isFinite(rubles) && rubles > 0 && Number.isSafeInteger(kopecks) ? kopecks : null;
};

export const extractVerifiedCdekCosts = (snapshot: SnapshotWithCost) => {
  const detail = snapshot.raw.entity?.delivery_detail;
  const baseAmountKopecks = toKopecks(detail?.delivery_sum);
  const totalAmountKopecks = toKopecks(detail?.total_sum);
  const currentTotalAmountKopecks = baseAmountKopecks !== null && totalAmountKopecks !== null &&
    totalAmountKopecks < baseAmountKopecks ? null : totalAmountKopecks;
  const additionalServicesAmountKopecks = baseAmountKopecks !== null && currentTotalAmountKopecks !== null
    ? currentTotalAmountKopecks - baseAmountKopecks : null;
  const state = mapCdekStatusToInternalDeliveryState(snapshot.status);
  const handedOver = ['HANDED_TO_DELIVERY', 'IN_TRANSIT', 'READY_FOR_PICKUP', 'DELIVERED', 'RETURNED'].includes(state);
  return {
    baseAmountKopecks,
    additionalServicesAmountKopecks,
    currentTotalAmountKopecks,
    actualAmountKopecks: handedOver ? currentTotalAmountKopecks : null
  };
};

export const extractVerifiedCdekActualCostKopecks = (snapshot: SnapshotWithCost): number | null =>
  extractVerifiedCdekCosts(snapshot).actualAmountKopecks;
