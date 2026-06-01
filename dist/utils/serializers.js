"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.financialsForSeller = exports.financialsForBuyer = exports.stripInternalOrderFields = exports.BUYER_SHIPMENT_SELECT = exports.BUYER_PUBLIC_SELECT = void 0;
const orderFinancials_1 = require("./orderFinancials");
// ─── Buyer select ──────────────────────────────────────────────────────────────
// Use in every Prisma query that includes buyer/user — never return raw user objects.
exports.BUYER_PUBLIC_SELECT = {
    id: true,
    name: true,
    email: true
};
// Shipment service needs phone to fill recipientPhone fallback
exports.BUYER_SHIPMENT_SELECT = {
    id: true,
    name: true,
    email: true,
    phone: true
};
// ─── Internal order fields ─────────────────────────────────────────────────────
// These fields must not be shown to buyers (payment internals, payout, fees).
const BUYER_HIDDEN_ORDER_FIELDS = new Set([
    'payoutStatus',
    'platformFeeKopecks',
    'sellerNetAmountKopecks',
    'grossAmountKopecks',
    'serviceFeeKopecks',
    'acquiringFeeKopecks',
    'platformFeePercent',
    'deliveryAmountKopecks',
    'grossAmountMinor',
    'platformFeeMinor',
    'providerFeeMinor',
    'serviceFeeMinor',
    'sellerNetAmountMinor',
    'yookassaDealId',
    'yookassaDealStatus',
    'yookassaPayoutId',
    'yookassaRefundId',
    'paymentAttemptKey',
]);
const stripInternalOrderFields = (order) => {
    const result = { ...order };
    for (const field of BUYER_HIDDEN_ORDER_FIELDS) {
        delete result[field];
    }
    return result;
};
exports.stripInternalOrderFields = stripInternalOrderFields;
// ─── Role-based financials ─────────────────────────────────────────────────────
const financialsForBuyer = (order) => {
    const full = (0, orderFinancials_1.formatOrderFinancials)(order);
    return {
        itemsSubtotal: full.itemsSubtotal,
        deliveryAmount: full.deliveryAmount,
        total: full.total,
        currency: full.currency
    };
};
exports.financialsForBuyer = financialsForBuyer;
const financialsForSeller = (order) => (0, orderFinancials_1.formatOrderFinancials)(order);
exports.financialsForSeller = financialsForSeller;
