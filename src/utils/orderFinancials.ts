export type OrderFinancialsSource = {
  total: number;
  deliveryAmountKopecks?: number | null;
  deliveryChargedToBuyerKopecks?: number | null;
  checkoutDeliveryEstimateKopecks?: number | null;
  packedDeliveryAmountKopecks?: number | null;
  actualDeliveryAmountKopecks?: number | null;
  acquiringFeeKopecks?: number | null;
  platformFeePercent?: number | null;
  platformFeeKopecks?: number | null;
  sellerNetAmountKopecks?: number | null;
  currency: string;
};

export const formatOrderFinancials = (order: OrderFinancialsSource) => {
  const actualDeliveryAmount = order.deliveryAmountKopecks ?? 0;
  const deliveryAmount = order.deliveryChargedToBuyerKopecks ?? actualDeliveryAmount;
  const itemsSubtotal = order.total - deliveryAmount;
  const effectiveDeliveryCost = order.actualDeliveryAmountKopecks ??
    order.packedDeliveryAmountKopecks ?? order.checkoutDeliveryEstimateKopecks ?? actualDeliveryAmount;
  const sellerNetAmount = order.sellerNetAmountKopecks ?? 0;

  return {
    itemsSubtotal,
    deliveryAmount,
    actualDeliveryAmount,
    checkoutDeliveryEstimateAmount: order.checkoutDeliveryEstimateKopecks ?? actualDeliveryAmount,
    packedDeliveryAmount: order.packedDeliveryAmountKopecks ?? null,
    confirmedActualDeliveryAmount: order.actualDeliveryAmountKopecks ?? null,
    effectiveDeliveryCost,
    sellerNetAfterDeliveryAmount: sellerNetAmount - effectiveDeliveryCost,
    total: order.total,
    platformFeePercent: order.platformFeePercent ?? null,
    platformFeeAmount: order.platformFeeKopecks ?? 0,
    acquiringFeeAmount: order.acquiringFeeKopecks ?? 0,
    sellerNetAmount,
    currency: order.currency
  };
};
