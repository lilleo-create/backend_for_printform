"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.formatOrderFinancials = void 0;
const formatOrderFinancials = (order) => {
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
exports.formatOrderFinancials = formatOrderFinancials;
