export type OrderFinancialsSource = {
  total: number;
  deliveryAmountKopecks?: number | null;
  deliveryChargedToBuyerKopecks?: number | null;
  platformFeePercent?: number | null;
  platformFeeKopecks?: number | null;
  sellerNetAmountKopecks?: number | null;
  currency: string;
};

export const formatOrderFinancials = (order: OrderFinancialsSource) => {
  const actualDeliveryAmount = order.deliveryAmountKopecks ?? 0;
  const deliveryAmount = order.deliveryChargedToBuyerKopecks ?? actualDeliveryAmount;
  const itemsSubtotal = order.total - deliveryAmount;

  return {
    itemsSubtotal,
    deliveryAmount,
    actualDeliveryAmount,
    total: order.total,
    platformFeePercent: order.platformFeePercent ?? null,
    platformFeeAmount: order.platformFeeKopecks ?? 0,
    sellerNetAmount: order.sellerNetAmountKopecks ?? 0,
    currency: order.currency
  };
};
