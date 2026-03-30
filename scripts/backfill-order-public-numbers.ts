import { prisma } from '../src/lib/prisma';
import { formatOrderPublicNumber } from '../src/utils/orderPublicId';

async function main() {
  const missingOrders = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT id
    FROM "Order"
    WHERE "publicNumber" IS NULL
    ORDER BY "createdAt" ASC, id ASC
  `;

  if (!missingOrders.length) {
    console.info('[BACKFILL_ORDER_PUBLIC_NUMBERS] nothing to update');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const counter = await tx.orderPublicNumberCounter.upsert({
      where: { scope: 'ORDER' },
      create: { scope: 'ORDER', lastValue: 0 },
      update: {},
      select: { lastValue: true }
    });

    let nextValue = counter.lastValue;
    for (const order of missingOrders) {
      nextValue += 1;
      await tx.order.update({
        where: { id: order.id },
        data: { publicNumber: formatOrderPublicNumber(nextValue) }
      });
    }

    await tx.orderPublicNumberCounter.update({
      where: { scope: 'ORDER' },
      data: { lastValue: nextValue }
    });
  });

  console.info('[BACKFILL_ORDER_PUBLIC_NUMBERS] updated', { count: missingOrders.length });
}

main()
  .catch((error) => {
    console.error('[BACKFILL_ORDER_PUBLIC_NUMBERS] failed', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
