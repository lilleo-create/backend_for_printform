import { prisma } from '../lib/prisma';

type OrderDeliveryRow = {
  order_id: string;
  delivery_payload: unknown;
};

const ensureOrderDeliveryTable = async () => {
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS order_delivery (
      order_id TEXT PRIMARY KEY REFERENCES "Order"(id) ON DELETE CASCADE,
      delivery_payload JSONB
    )
  `);
};

export const orderDeliveryService = {
  upsert: async (orderId: string, payload: unknown) => {
    await ensureOrderDeliveryTable();
    await prisma.$executeRawUnsafe(
      `
      INSERT INTO order_delivery (order_id, delivery_payload)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (order_id) DO UPDATE SET delivery_payload = EXCLUDED.delivery_payload
      `,
      orderId,
      JSON.stringify(payload)
    );
  },

  getByOrderIds: async (orderIds: string[]) => {
    await ensureOrderDeliveryTable();
    if (orderIds.length === 0) return new Map<string, unknown>();

    const rows = (await prisma.$queryRawUnsafe(
      `SELECT order_id, delivery_payload FROM order_delivery WHERE order_id = ANY($1::text[])`,
      orderIds
    )) as OrderDeliveryRow[];

    return new Map(rows.map((row) => [row.order_id, row.delivery_payload]));
  }
};
