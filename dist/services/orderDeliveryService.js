"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.orderDeliveryService = void 0;
const prisma_1 = require("../lib/prisma");
const ensureOrderDeliveryTable = async () => {
    await prisma_1.prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS order_delivery (
      order_id TEXT PRIMARY KEY REFERENCES "Order"(id) ON DELETE CASCADE,
      delivery_payload JSONB
    )
  `);
};
exports.orderDeliveryService = {
    upsert: async (orderId, payload) => {
        await ensureOrderDeliveryTable();
        await prisma_1.prisma.$executeRawUnsafe(`
      INSERT INTO order_delivery (order_id, delivery_payload)
      VALUES ($1, $2::jsonb)
      ON CONFLICT (order_id) DO UPDATE SET delivery_payload = EXCLUDED.delivery_payload
      `, orderId, JSON.stringify(payload));
    },
    getByOrderIds: async (orderIds) => {
        await ensureOrderDeliveryTable();
        if (orderIds.length === 0)
            return new Map();
        const rows = (await prisma_1.prisma.$queryRawUnsafe(`SELECT order_id, delivery_payload FROM order_delivery WHERE order_id = ANY($1::text[])`, orderIds));
        return new Map(rows.map((row) => [row.order_id, row.delivery_payload]));
    }
};
