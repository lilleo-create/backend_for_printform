import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';

const asObject = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const toNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
};

const extractDealId = (payloadJson: unknown): string | null => {
  const payload = asObject(payloadJson);
  if (!payload) return null;
  const objectNode = asObject(payload.object);
  const metadata = asObject(payload.metadata) ?? asObject(objectNode?.metadata);
  const deal = asObject(payload.deal) ?? asObject(objectNode?.deal);
  return (
    toNonEmptyString(payload.dealId) ??
    toNonEmptyString(payload.yookassaDealId) ??
    toNonEmptyString(metadata?.dealId) ??
    toNonEmptyString(deal?.id) ??
    null
  );
};

async function main() {
  const ordersWithoutDeal = await prisma.order.findMany({
    where: {
      yookassaDealId: null,
      paymentStatus: 'PAID'
    },
    select: {
      id: true,
      publicNumber: true
    },
    orderBy: [{ createdAt: 'asc' }]
  });

  if (!ordersWithoutDeal.length) {
    console.info('[BACKFILL_YOOKASSA_DEAL_IDS] nothing to update');
    return;
  }

  const orderIds = ordersWithoutDeal.map((item) => item.id);
  const payments = await prisma.payment.findMany({
    where: { orderId: { in: orderIds } },
    select: { id: true, orderId: true, payloadJson: true, createdAt: true },
    orderBy: [{ createdAt: 'desc' }]
  });

  const latestDealByOrder = new Map<string, { paymentId: string; dealId: string }>();
  for (const payment of payments) {
    if (latestDealByOrder.has(payment.orderId)) continue;
    const dealId = extractDealId(payment.payloadJson);
    if (!dealId) continue;
    latestDealByOrder.set(payment.orderId, { paymentId: payment.id, dealId });
  }

  let updated = 0;
  for (const order of ordersWithoutDeal) {
    const match = latestDealByOrder.get(order.id);
    if (!match) continue;
    await prisma.order.updateMany({
      where: { id: order.id, yookassaDealId: null },
      data: { yookassaDealId: match.dealId, yookassaDealStatus: 'open' }
    });
    const existingPayload = payments.find((item) => item.id === match.paymentId)?.payloadJson;
    const payload = asObject(existingPayload) ?? {};
    const metadata = asObject(payload.metadata) ?? {};
    await prisma.payment.update({
      where: { id: match.paymentId },
      data: {
        payloadJson: {
          ...payload,
          metadata: {
            ...metadata,
            dealId: match.dealId
          },
          dealId: match.dealId,
          yookassaDealId: match.dealId
        } as Prisma.InputJsonValue
      }
    });
    updated += 1;
    console.info('[BACKFILL_YOOKASSA_DEAL_IDS][UPDATED]', {
      orderId: order.id,
      publicNumber: order.publicNumber,
      paymentId: match.paymentId,
      dealId: match.dealId
    });
  }

  console.info('[BACKFILL_YOOKASSA_DEAL_IDS][DONE]', {
    checked: ordersWithoutDeal.length,
    updated
  });
}

main()
  .catch((error) => {
    console.error('[BACKFILL_YOOKASSA_DEAL_IDS][FAILED]', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
