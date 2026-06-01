export type OrderFinancialsSource = {
  total: number;
  deliveryAmountKopecks?: number | null;
  platformFeePercent?: number | null;
  platformFeeKopecks?: number | null;
  sellerNetAmountKopecks?: number | null;
  currency: string;
};

export const formatOrderFinancials = (order: OrderFinancialsSource) => {
  const deliveryAmount = order.deliveryAmountKopecks ?? 0;
  const itemsSubtotal = order.total - deliveryAmount;

  return {
    itemsSubtotal,
    deliveryAmount,
    total: order.total,
    platformFeePercent: order.platformFeePercent ?? null,
    platformFeeAmount: order.platformFeeKopecks ?? 0,
    sellerNetAmount: order.sellerNetAmountKopecks ?? 0,
    currency: order.currency
  };
};
