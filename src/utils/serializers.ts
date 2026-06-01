import type { OrderFinancialsSource } from './orderFinancials';
import { formatOrderFinancials } from './orderFinancials';

// ─── Buyer select ──────────────────────────────────────────────────────────────
// Use in every Prisma query that includes buyer/user — never return raw user objects.

export const BUYER_PUBLIC_SELECT = {
  id: true,
  name: true,
  email: true
} as const;

// Shipment service needs phone to fill recipientPhone fallback
export const BUYER_SHIPMENT_SELECT = {
  id: true,
  name: true,
  email: true,
  phone: true
} as const;

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

export const stripInternalOrderFields = <T extends Record<string, unknown>>(order: T): Omit<T, string> => {
  const result = { ...order } as Record<string, unknown>;
  for (const field of BUYER_HIDDEN_ORDER_FIELDS) {
    delete result[field];
  }
  return result as Omit<T, string>;
};

// ─── Role-based financials ─────────────────────────────────────────────────────

export const financialsForBuyer = (order: OrderFinancialsSource) => {
  const full = formatOrderFinancials(order);
  return {
    itemsSubtotal: full.itemsSubtotal,
    deliveryAmount: full.deliveryAmount,
    total: full.total,
    currency: full.currency
  };
};

export const financialsForSeller = (order: OrderFinancialsSource) =>
  formatOrderFinancials(order);
